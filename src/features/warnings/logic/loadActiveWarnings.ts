import { ACTIVE_WARNINGS_CARD_ROW_LIMIT } from '../constants';
import { warningsRepo } from '../data/warningsRepo';
import type { ActiveWarningMemberSummary } from '../data/warningsRepo';
import type { Warning } from '../data/warningsSchema';
import { getActiveAsOfUtcMidnight } from './warningDates';

export type ActiveWarningSummaries = {
    summaries: ActiveWarningMemberSummary[];
    totalWarnings: number;
    totalMembers: number;
};

export type ActiveMemberWarnings = {
    warnings: Warning[];
    totalActive: number;
};

export async function loadActiveWarningSummaries(
    guildId: string,
    now: Date = new Date(),
    limit: number = ACTIVE_WARNINGS_CARD_ROW_LIMIT
): Promise<ActiveWarningSummaries> {
    const asOf = getActiveAsOfUtcMidnight(now);
    const [summaries, totalWarnings, totalMembers] = await Promise.all([
        warningsRepo.listActiveMemberSummaries(guildId, asOf, limit),
        warningsRepo.countActive(guildId, asOf),
        warningsRepo.countActiveMembers(guildId, asOf),
    ]);

    return { summaries, totalWarnings, totalMembers };
}

export async function loadActiveMemberWarnings(
    guildId: string,
    userId: string,
    now: Date = new Date(),
    limit: number = ACTIVE_WARNINGS_CARD_ROW_LIMIT
): Promise<ActiveMemberWarnings> {
    const asOf = getActiveAsOfUtcMidnight(now);
    const [warnings, totalActive] = await Promise.all([
        warningsRepo.listActive(guildId, asOf, { limit, userId }),
        warningsRepo.countActive(guildId, asOf, userId),
    ]);

    return { warnings, totalActive };
}
