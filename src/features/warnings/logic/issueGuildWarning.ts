import { warningsRepo } from '../data/warningsRepo';
import type { Warning } from '../data/warningsSchema';
import {
    calendarDateToUtcMidnightIso,
    resolveWarningDates,
    type WarningDateErrorKind,
} from './warningDates';
import { generateWarningSlug, withUniqueSlugRetry } from './warningSlug';

export type IssueGuildWarningInput = {
    guildId: string;
    userId: string;
    issuerId: string;
    rule: string;
    description: string;
    issuedInput: string;
    expiresInput: string;
    now?: Date;
};

export type IssueGuildWarningResult =
    | { ok: true; warning: Warning }
    | { ok: false; kind: WarningDateErrorKind | 'empty-rule' | 'empty-description' };

export async function issueGuildWarning(input: IssueGuildWarningInput): Promise<IssueGuildWarningResult> {
    const rule = input.rule.trim();
    const description = input.description.trim();

    if (!rule) {
        return { ok: false, kind: 'empty-rule' };
    }

    if (!description) {
        return { ok: false, kind: 'empty-description' };
    }

    const dates = resolveWarningDates({
        issuedInput: input.issuedInput,
        expiresInput: input.expiresInput,
        now: input.now,
    });

    if (!dates.ok) {
        return dates;
    }

    const now = input.now ?? new Date();
    const createdAt = now.toISOString();

    const warning = await withUniqueSlugRetry(
        () => generateWarningSlug(rule),
        async (slug) =>
            warningsRepo.insert({
                guildId: input.guildId,
                userId: input.userId,
                issuerId: input.issuerId,
                slug,
                rule,
                description,
                issuedAt: calendarDateToUtcMidnightIso(dates.issued),
                expiresAt: calendarDateToUtcMidnightIso(dates.expires),
                clearedAt: null,
                clearedById: null,
                createdAt,
            })
    );

    return { ok: true, warning };
}
