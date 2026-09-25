/**
 * Leveling API helpers. Same style as `tickets.ts` — pages stay URL-free.
 *
 * Read-only, because the endpoints are. Leveling's XP tuning has no write path in the bot
 * and five of its config columns are overwritten by `constants.ts` on every read, so there
 * is deliberately no `updateLeveling*` here to pair with the getters.
 */

import { api } from './client';
import type {
    LevelingInsightsBody,
    LevelingListResult,
    LevelingUserDetail,
    StatsPeriod,
} from './types';

/** The guild leaderboard, capped server-side — read `truncated` before believing the count. */
export function listLeveling(guildId: string): Promise<LevelingListResult> {
    return api.get<LevelingListResult>(`/api/guilds/${guildId}/leveling`);
}

/**
 * One member's stats.
 *
 * `period` is optional and omitted from the query when absent, so the **first** read lets
 * the server apply its own `DEFAULT_STATS_PERIOD` rather than this side asserting a default
 * the bot might change. That is not decoration: `LevelingUserPage` calls it with no period
 * initially and then adopts `detail.statsPeriod` from the response, so the picker shows the
 * window that was actually aggregated even if the bot's default moves.
 *
 * The type is `StatsPeriod`, so a string only the browser knows about cannot be sent and
 * silently downgraded to the default by `parseStatsPeriod`.
 */
export function getLevelingUser(
    guildId: string,
    userId: string,
    period?: StatsPeriod
): Promise<LevelingUserDetail> {
    const query = period ? `?period=${period}` : '';
    return api.get<LevelingUserDetail>(
        `/api/guilds/${guildId}/leveling/users/${userId}${query}`
    );
}

/**
 * The guild-wide insights report.
 *
 * Takes no parameters: the server computes the whole report from every logged XP day and
 * caches it, so there is no window to narrow and nothing this side could ask it to filter.
 *
 * **Refuses with a 503 on a guild too large to scan**, which is a capacity answer rather
 * than a fault — `ApiError.status` is how the caller tells that apart from a real failure,
 * so this deliberately does not catch it and flatten the distinction into a null.
 */
export function getLevelingInsights(guildId: string): Promise<LevelingInsightsBody> {
    return api.get<LevelingInsightsBody>(`/api/guilds/${guildId}/leveling/insights`);
}
