import { warningsRepo } from '../data/warningsRepo';
import type { Warning, WarningActor } from '../data/warningsSchema';
import {
    calendarDateFromUtcMidnight,
    calendarDateToUtcMidnightIso,
    formatCalendarDate,
    formatWarningDate,
    parseWarningDateInput,
    resolveWarningDates,
    type CalendarDate,
} from './warningDates';
import type { WarningInputRefusal } from './warningRefusals';
import { normalizeWarningSlug } from './warningSlug';

/** Which field an edit changed. Not the issued date: it is when the thing happened, and cannot be edited. */
export type WarningChangedField = 'rule' | 'description' | 'dropsOffOn';

/** One field an edit changed, as the mod-log notice shows it. Dates are `YYYY-MM-DD`. */
export type WarningChange = {
    readonly field: WarningChangedField;
    readonly before: string;
    readonly after: string;
};

export type EditGuildWarningInput = {
    readonly guildId: string;
    readonly slug: string;
    readonly rule: string;
    readonly description: string;
    /** The new drop-off date, `YYYY-MM-DD`. */
    readonly dropsOffInput: string;
    /**
     * When the warning was last edited as the editor loaded it (ISO), or null if it had
     * never been edited. A warning edited since then is refused as `stale`, so a dialog left
     * open cannot revert somebody else's edit.
     */
    readonly baseEditedAt: string | null;
    readonly editedBy: WarningActor;
    readonly now?: Date;
};

/**
 * Why an edit changed nothing:
 *  - a {@link WarningInputRefusal} — a blank field or a drop-off the date rules refuse;
 *  - `unchanged` — the edit would leave every field as it is;
 *  - `not-found` — no warning by that slug in this server;
 *  - `released` — released warnings are the record of a closed matter, and stay as they are;
 *  - `stale` — somebody else edited it after the editor loaded it, or after it was read
 *    here; reload and edit again.
 */
export type EditGuildWarningRefusal = WarningInputRefusal | 'unchanged' | 'not-found' | 'released' | 'stale';

export type EditGuildWarningResult =
    | { ok: true; warning: Warning; changes: readonly WarningChange[] }
    | { ok: false; kind: EditGuildWarningRefusal };

/**
 * The drop-off an edit asks for, held to the date rules against the warning's own issued
 * date — the same rules `/warn` applies.
 *
 * **One exception: a drop-off left as it was is not re-judged.** It was judged when it was
 * set, and judging it again against today would refuse every edit to an expired warning
 * that does not also move its date — fixing a typo in one would mean reviving it. Moving the
 * date of an expired warning is judged in full, so it can only move into the future, which
 * is how a moderator extends one.
 */
function resolveDropsOff(
    existing: Warning,
    dropsOffInput: string,
    now: Date
): { ok: true; dropsOff: CalendarDate } | { ok: false; kind: WarningInputRefusal } {
    const stored = calendarDateFromUtcMidnight(existing.expiresAt);
    const parsed = parseWarningDateInput(dropsOffInput);
    if (parsed !== null && parsed !== 'invalid' && formatCalendarDate(parsed) === formatCalendarDate(stored)) {
        return { ok: true, dropsOff: stored };
    }

    const dates = resolveWarningDates({
        issuedInput: formatWarningDate(existing.issuedAt),
        expiresInput: dropsOffInput,
        now,
    });
    return dates.ok ? { ok: true, dropsOff: dates.expires } : dates;
}

/** Whether the row's last edit is still the one the editor loaded. Compared as instants, not as strings. */
function isSameEdit(editedAt: Date | null, baseEditedAt: string | null): boolean {
    if (!editedAt || !baseEditedAt) {
        return !editedAt && !baseEditedAt;
    }
    return editedAt.getTime() === new Date(baseEditedAt).getTime();
}

function changesBetween(before: Warning, after: Readonly<Record<WarningChangedField, string>>): WarningChange[] {
    const pairs: WarningChange[] = [
        { field: 'rule', before: before.rule, after: after.rule },
        { field: 'description', before: before.description, after: after.description },
        { field: 'dropsOffOn', before: formatWarningDate(before.expiresAt), after: after.dropsOffOn },
    ];
    return pairs.filter((change) => change.before !== change.after);
}

/**
 * Change a warning's rule, description or drop-off date — the only edit path. Dashboard
 * only; there is no `/warn-edit`.
 *
 * Records who edited it and when (the last edit only), and returns what changed so the
 * caller can post the edited notice. Refused when the warning was edited after the editor
 * loaded it (`baseEditedAt`); and the write is conditional on the row still being unreleased
 * and unchanged since it was read here, so neither a release nor another edit landing in
 * between is silently overwritten.
 */
export async function editGuildWarning(input: EditGuildWarningInput): Promise<EditGuildWarningResult> {
    const now = input.now ?? new Date();
    const slug = normalizeWarningSlug(input.slug);
    const rule = input.rule.trim();
    const description = input.description.trim();

    if (!rule) {
        return { ok: false, kind: 'empty-rule' };
    }

    if (!description) {
        return { ok: false, kind: 'empty-description' };
    }

    const existing = slug ? await warningsRepo.getByGuildAndSlug(input.guildId, slug) : null;
    if (!existing) {
        return { ok: false, kind: 'not-found' };
    }

    if (existing.clearedAt) {
        return { ok: false, kind: 'released' };
    }

    // Before the date rules: a form built from an older version is judged by its staleness,
    // not by fields it may have meant to change on top of somebody else's.
    if (!isSameEdit(existing.editedAt, input.baseEditedAt)) {
        return { ok: false, kind: 'stale' };
    }

    const dropsOff = resolveDropsOff(existing, input.dropsOffInput, now);
    if (!dropsOff.ok) {
        return dropsOff;
    }

    const changes = changesBetween(existing, { rule, description, dropsOffOn: formatCalendarDate(dropsOff.dropsOff) });
    if (changes.length === 0) {
        return { ok: false, kind: 'unchanged' };
    }

    const updated = await warningsRepo.updateEditable(
        input.guildId,
        slug,
        existing,
        { rule, description, expiresAt: calendarDateToUtcMidnightIso(dropsOff.dropsOff) },
        input.editedBy,
        now.toISOString()
    );

    const warning = await warningsRepo.getByGuildAndSlug(input.guildId, slug);
    if (!warning) {
        return { ok: false, kind: 'not-found' };
    }

    // The statement's own condition refused it: released, or edited by somebody else, since the read above.
    if (!updated) {
        return { ok: false, kind: warning.clearedAt ? 'released' : 'stale' };
    }

    return { ok: true, warning, changes };
}
