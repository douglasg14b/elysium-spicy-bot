/**
 * The leaderboard's summary figures, derived from the rows actually on screen.
 *
 * Lifted out of `LevelingPage` because the page's own rule says so: a reduction left in a
 * component is one only a render can check. Three of these
 * looked too small to matter, and one of them is not — see `topLevel`.
 */

import type { LevelingRankingRow } from '@brattybot/web-sdk';

export interface LeaderboardTotals {
    /** Messages across the shown rows. Not a server-wide total. */
    readonly shownMessages: number;
    /** Reactions across the shown rows. Not a server-wide total. */
    readonly shownReactions: number;
    /**
     * The highest level among the shown rows.
     *
     * A max rather than `entries[0].level`, and the difference is real: rows are ranked by
     * `totalXp`, while `level` is a stored column the bot writes on grant. A row whose level
     * has fallen behind its XP — or a board truncated below someone who has not been
     * recalculated — makes rank 1 and top level different members.
     */
    readonly topLevel: number;
}

/**
 * Summarise the rows on screen.
 *
 * Every figure is zero for an empty list rather than absent: a board with no ranked members
 * has genuinely had no messages, and a dash there would read as "we could not work it out".
 */
export function leaderboardTotals(entries: readonly LevelingRankingRow[]): LeaderboardTotals {
    return {
        shownMessages: entries.reduce((sum, entry) => sum + entry.messageCount, 0),
        shownReactions: entries.reduce((sum, entry) => sum + entry.reactionCount, 0),
        topLevel: entries.reduce((highest, entry) => Math.max(highest, entry.level), 0),
    };
}
