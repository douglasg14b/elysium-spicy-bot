import { warningsRepo } from '../data/warningsRepo';
import type { Warning } from '../data/warningsSchema';
import { calendarDateToUtcMidnightIso, resolveWarningDates } from './warningDates';
import type { WarningInputRefusal } from './warningRefusals';
import { generateWarningSlug, withUniqueSlugRetry } from './warningSlug';

export type IssueGuildWarningInput = {
    guildId: string;
    userId: string;
    /** The warned member's display name now, recorded so the dashboard can name them without a lookup. */
    userName: string;
    issuerId: string;
    /** The issuer's display name now. */
    issuerName: string;
    rule: string;
    description: string;
    issuedInput: string;
    expiresInput: string;
    now?: Date;
};

export type IssueGuildWarningResult = { ok: true; warning: Warning } | { ok: false; kind: WarningInputRefusal };

/** Issue a warning — the one write path for `/warn` and the dashboard alike. */
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
                userName: input.userName,
                issuerId: input.issuerId,
                issuerName: input.issuerName,
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
