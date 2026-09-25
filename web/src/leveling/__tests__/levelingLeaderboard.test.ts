import { describe, expect, it } from 'vitest';
import { leaderboardTotals } from '../levelingLeaderboard';
import type { LevelingRankingRow } from '../../api/types';

/**
 * The leaderboard's summary tiles.
 *
 * Two of the three are sums and hold no surprises. `topLevel` is the one worth a test: it is a
 * max rather than the first row's level, because the board is ranked by XP and `level` is a
 * stored column that can disagree with it.
 */

function row(overrides: Partial<LevelingRankingRow> = {}): LevelingRankingRow {
    return {
        rank: 1,
        userId: '100000000000000001',
        member: null,
        level: 5,
        totalXp: 1_000,
        messageCount: 10,
        reactionCount: 4,
        photoUploadCount: 2,
        lastActiveAt: null,
        ...overrides,
    };
}

describe('leaderboardTotals', () => {
    it('adds up messages and reactions across the shown rows', () => {
        const totals = leaderboardTotals([
            row({ messageCount: 10, reactionCount: 4 }),
            row({ messageCount: 7, reactionCount: 1 }),
        ]);

        expect(totals.shownMessages).toBe(17);
        expect(totals.shownReactions).toBe(5);
    });

    it('reports zeroes for an empty board rather than nothing', () => {
        // A server with no ranked members has genuinely had no messages. A dash here would read
        // as "we could not work it out", which is a different claim.
        const totals = leaderboardTotals([]);

        expect(totals).toEqual({ shownMessages: 0, shownReactions: 0, topLevel: 0 });
    });

    it("takes the highest level, not the top-ranked row's", () => {
        /*
         * The case that makes this a max. Rows are ordered by `totalXp`, but `level` is a stored
         * column written at grant time, so a row can sit second on XP while holding the higher
         * level — a member whose level was recalculated when the first member's was not.
         * Reading `entries[0].level` would under-report the board.
         */
        const totals = leaderboardTotals([
            row({ rank: 1, totalXp: 5_000, level: 7 }),
            row({ rank: 2, totalXp: 4_900, level: 9 }),
        ]);

        expect(totals.topLevel).toBe(9);
    });
});
