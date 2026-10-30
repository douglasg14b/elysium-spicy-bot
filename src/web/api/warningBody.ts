import { z } from '@hono/zod-openapi';
import type { GuildMemberSnapshot } from '../../features/leveling/logic/belowThresholdReport';
import {
    WARN_DESCRIPTION_MAX_LENGTH,
    WARN_RELEASE_REASON_MAX_LENGTH,
    WARN_RULE_MAX_LENGTH,
} from '../../features/warnings/constants';
import type { Warning } from '../../features/warnings/data/warningsSchema';
import { formatWarningDate } from '../../features/warnings/logic/warningDates';
import { WARNING_NOTICE_STATUSES, type WarningNoticeStatus } from '../../features/warnings/logic/warningNotice';
import {
    EMPTY_RELEASE_REASON_SENTENCE,
    warningInputRefusalSentence,
} from '../../features/warnings/logic/warningRefusals';
import { WARNING_STATUSES, warningStatus } from '../../features/warnings/logic/warningStatus';

/**
 * The warning shapes the dashboard sends and receives.
 *
 * Each is a zod schema made with `@hono/zod-openapi`'s `z`, and the schema **is** the
 * contract: `warningRoutes` declares it, `router.openapi` type-checks every `c.json(...)`
 * against it, and the spec names it as a component the SDK is generated from. The builders
 * below are typed by `z.infer` of their schema.
 *
 * **Dates a warning is about are calendar dates** (`YYYY-MM-DD`), not instants. A warning's
 * days are Pacific calendar days stored at UTC midnight (`warningDates.ts`); sent as
 * instants, the browser would re-zone them into the day before. The edit and release
 * moments are real instants and travel as ISO strings.
 */

/** A calendar date as the routes take it. The date rules that need "today" are the handler's. */
const CALENDAR_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const WarningStatusSchema = z.enum(WARNING_STATUSES).openapi('WarningStatus', {
    description:
        '`released` once a moderator released it (whether or not it had dropped off), `expired` once its ' +
        'drop-off day has passed on the Pacific calendar, `active` otherwise.',
});

const WarningNoticeStatusSchema = z.enum(WARNING_NOTICE_STATUSES).openapi('WarningNoticeStatus', {
    description:
        'Whether the mod-log notice went out. The warning is saved whatever this says: `unconfigured` means the ' +
        'server has no mod channel, `skipped` that the bot cannot reach it, `failed` that the post threw.',
});

/**
 * Somebody on a warning, as the row recorded them. `name` is null on a row written before
 * names were recorded; show the id then. Not backfilled — that would mean fetching every
 * historical member.
 */
const WarningPersonSchema = z
    .object({
        id: z.string(),
        name: z.string().nullable(),
    })
    .openapi('WarningPerson', {
        description:
            'Somebody on a warning, as the row recorded them. `name` is null on a warning written before names ' +
            'were recorded; show the id then.',
    });

type WarningPersonBody = z.infer<typeof WarningPersonSchema>;

const WarningEditSchema = z
    .object({
        by: WarningPersonSchema,
        at: z.string(),
    })
    .openapi('WarningEdit', { description: 'The last edit: who, and when (ISO).' });

const WarningReleaseSchema = z
    .object({
        by: WarningPersonSchema,
        at: z.string(),
        reason: z.string().nullable(),
    })
    .openapi('WarningRelease', {
        description: 'The release: who, when (ISO), and why. `reason` is null on a warning released before reasons were recorded.',
    });

export const WarningSchema = z
    .object({
        slug: z.string(),
        rule: z.string(),
        description: z.string(),
        member: WarningPersonSchema,
        issuedBy: WarningPersonSchema,
        issuedOn: z.string(),
        dropsOffOn: z.string(),
        status: WarningStatusSchema,
        // Unions rather than `.nullable()`: the generator copies a named schema's name onto
        // its nullable variant, so the component itself would become nullable.
        edited: z.union([WarningEditSchema, z.null()]),
        released: z.union([WarningReleaseSchema, z.null()]),
    })
    .openapi('Warning', {
        description:
            'One warning. `issuedOn` and `dropsOffOn` are Pacific calendar dates (`YYYY-MM-DD`); it counts as ' +
            'active through its drop-off day. `edited` is the last edit only.',
    });

type WarningBody = z.infer<typeof WarningSchema>;

export const WarningResultSchema = WarningSchema.extend({
    notice: WarningNoticeStatusSchema,
}).openapi('WarningResult', {
    description: 'The warning as saved, and whether its mod-log notice went out. Say so plainly when it did not.',
});

const WarningCountsSchema = z
    .object({
        active: z.number(),
        expired: z.number(),
        released: z.number(),
    })
    .openapi('WarningCounts', { description: "The server's warning totals, whatever the list is filtered to." });

export const WarningListSchema = z
    .object({
        warnings: z.array(WarningSchema),
        counts: WarningCountsSchema,
        truncated: z.boolean(),
    })
    .openapi('WarningList', {
        description:
            'The warnings matching the filter, newest issued first. `truncated` means the list was capped and more ' +
            'match; `counts` still reports the whole server.',
    });

/** A member a name search found, for the issue dialog's picker. */
const GuildMemberMatchSchema = z
    .object({
        id: z.string(),
        displayName: z.string(),
        username: z.string(),
        avatarUrl: z.string().nullable(),
    })
    .openapi('GuildMemberMatch', {
        description: 'A member whose name starts with the search. `avatarUrl` is null when they have no avatar.',
    });

type GuildMemberMatchBody = z.infer<typeof GuildMemberMatchSchema>;

export const GuildMemberMatchListSchema = z.array(GuildMemberMatchSchema);

/* ---- Requests ---- */

const ruleField = z
    .string()
    .trim()
    .min(1, warningInputRefusalSentence('empty-rule'))
    .max(WARN_RULE_MAX_LENGTH, `Keep the rule to ${WARN_RULE_MAX_LENGTH} characters. Name the line, not the essay.`);

const descriptionField = z
    .string()
    .trim()
    .min(1, warningInputRefusalSentence('empty-description'))
    .max(
        WARN_DESCRIPTION_MAX_LENGTH,
        `Keep the description to ${WARN_DESCRIPTION_MAX_LENGTH} characters. Specific, not a saga.`
    );

const dropsOffField = z.string().regex(CALENDAR_DATE_PATTERN, warningInputRefusalSentence('invalid-expires'));

export const WarningIssueSchema = z
    .object({
        userId: z.string().regex(/^\d{17,20}$/, 'Pick a member to warn.'),
        rule: ruleField,
        description: descriptionField,
        issuedOn: z.string().regex(CALENDAR_DATE_PATTERN, warningInputRefusalSentence('invalid-issued')).optional(),
        dropsOffOn: dropsOffField.optional(),
    })
    .openapi('WarningIssue', {
        description:
            'A new warning. `issuedOn` defaults to today and `dropsOffOn` to six months after it (Pacific calendar). ' +
            'The issued date cannot be in the future, and the drop-off must be after it and not already past.',
    });

export const WarningUpdateSchema = z
    .object({
        rule: ruleField,
        description: descriptionField,
        dropsOffOn: dropsOffField,
        // A union rather than `.nullable()`, as the response's nullables are: required, and
        // null only for a warning never edited.
        baseEditedAt: z.union([z.iso.datetime(), z.null()]),
    })
    .openapi('WarningUpdate', {
        description:
            "A warning's editable fields, all three always, and `baseEditedAt`: the `edited.at` the form was loaded " +
            'from, or null if the warning had never been edited. A warning edited since is refused (409, reload). ' +
            'A drop-off that moves must be after the issued date and not already past; one left as it was is not ' +
            'judged again, so an expired warning can be corrected without reviving it.',
    });

export const WarningReleaseRequestSchema = z
    .object({
        reason: z
            .string()
            .trim()
            .min(1, EMPTY_RELEASE_REASON_SENTENCE)
            .max(
                WARN_RELEASE_REASON_MAX_LENGTH,
                `Keep the reason to ${WARN_RELEASE_REASON_MAX_LENGTH} characters. It's a record, not a memoir.`
            ),
    })
    .openapi('WarningReleaseRequest', { description: 'Why the warning is released. Kept on the record.' });

/* ---- Builders ---- */

function person(id: string, name: string | null): WarningPersonBody {
    return { id, name };
}

/** A moment a warning records together with who acted then: its release, or its last edit. */
type RecordedAct = {
    readonly at: Date | null;
    readonly id: string | null;
    readonly name: string | null;
};

/**
 * Who acted and when, or null when nobody has. The moment and the id are always written in
 * one statement, so a moment without its id is a broken row — and saying so beats
 * inventing an id.
 */
function actorAt(act: RecordedAct, what: 'release' | 'edit', slug: string): { by: WarningPersonBody; at: string } | null {
    if (!act.at) return null;
    if (!act.id) throw new Error(`Warning ${slug} has a ${what} time but no ${what} id.`);
    return { by: person(act.id, act.name), at: act.at.toISOString() };
}

/** A warning row as {@link WarningSchema}, its status judged at `now`. */
export function warningView(warning: Warning, now: Date): WarningBody {
    const released = actorAt(
        { at: warning.clearedAt, id: warning.clearedById, name: warning.clearedByName },
        'release',
        warning.slug
    );

    return {
        slug: warning.slug,
        rule: warning.rule,
        description: warning.description,
        member: person(warning.userId, warning.userName),
        issuedBy: person(warning.issuerId, warning.issuerName),
        issuedOn: formatWarningDate(warning.issuedAt),
        dropsOffOn: formatWarningDate(warning.expiresAt),
        status: warningStatus(warning, now),
        edited: actorAt({ at: warning.editedAt, id: warning.editedById, name: warning.editedByName }, 'edit', warning.slug),
        released: released ? { ...released, reason: warning.clearReason } : null,
    };
}

/** A warning as {@link WarningResultSchema}: the view plus how its notice went. */
export function warningResult(
    warning: Warning,
    notice: WarningNoticeStatus,
    now: Date
): z.infer<typeof WarningResultSchema> {
    return { ...warningView(warning, now), notice };
}

/** A member snapshot as {@link GuildMemberMatchSchema}. */
export function memberMatch(snapshot: GuildMemberSnapshot): GuildMemberMatchBody {
    return {
        id: snapshot.userId,
        displayName: snapshot.displayName,
        username: snapshot.username,
        avatarUrl: snapshot.avatarUrl,
    };
}
