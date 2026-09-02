import { ACTIVE_WARNINGS_CARD_ROW_LIMIT } from '../constants';
import { warningsRepo } from '../data/warningsRepo';
import type { Warning } from '../data/warningsSchema';
import { getActiveAsOfUtcMidnight } from './warningDates';

export type ActiveGuildWarnings = {
    warnings: Warning[];
    totalActive: number;
};

export async function loadActiveGuildWarnings(
    guildId: string,
    now: Date = new Date(),
    limit: number = ACTIVE_WARNINGS_CARD_ROW_LIMIT
): Promise<ActiveGuildWarnings> {
    const asOf = getActiveAsOfUtcMidnight(now);
    const [warnings, totalActive] = await Promise.all([
        warningsRepo.listActive(guildId, asOf, limit),
        warningsRepo.countActive(guildId, asOf),
    ]);

    return { warnings, totalActive };
}
