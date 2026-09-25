import { describe, expect, it } from 'vitest';
import { buildMemberProgressions, type DailyXpRow } from '../levelCrossings';
import { getTotalXpForLevel } from '../xpCalculator';

/**
 * Reconstructing when each member crossed each level.
 *
 * Nothing stores a level-up date, so this is the only thing that can answer "how long did
 * that take" — and every number it produces looks plausible when it is wrong. The cases
 * below are the ones where a reasonable implementation quietly differs: a multi-level day,
 * an unordered input, and the question of what level 1 means.
 */

function row(userId: string, activityDate: string, xpAmount: number): DailyXpRow {
    return { userId, activityDate, xpAmount };
}

/** Exactly enough XP to stand at `level`, so a threshold boundary is testable. */
function xpForLevel(level: number): number {
    return getTotalXpForLevel(level);
}

describe('buildMemberProgressions', () => {
    it('dates each crossing by the day the threshold was passed', () => {
        const progressions = buildMemberProgressions([
            row('user-1', '2026-01-01', xpForLevel(2) - 1),
            // The day the second level's threshold is finally met.
            row('user-1', '2026-01-04', 1),
        ]);

        expect(progressions[0]?.crossings).toEqual([{ level: 2, days: 3 }]);
    });

    it('records every level crossed on a single huge day, not just the first', () => {
        /*
         * The `while` loop's reason for being. With an `if`, a member who jumped from 1 to 5
         * in one sitting would be recorded as reaching level 2 and never 3, 4 or 5 — so the
         * reach curve would show nobody at those levels while the leaderboard showed them at
         * 5, and the two would disagree with no way to tell which lied.
         */
        const progressions = buildMemberProgressions([row('user-1', '2026-01-01', xpForLevel(5))]);

        expect(progressions[0]?.crossings.map((crossing) => crossing.level)).toEqual([2, 3, 4, 5]);
        // All on day zero: the climb took no time because it happened on their first day.
        expect(progressions[0]?.crossings.every((crossing) => crossing.days === 0)).toBe(true);
    });

    it('never reports level 1 as a crossing', () => {
        // Everybody starts at level 1, so "reached level 1" took no time and is not an event.
        // Counting it would put a meaningless 100%-at-day-zero point on every chart.
        const progressions = buildMemberProgressions([row('user-1', '2026-01-01', 5)]);

        expect(progressions[0]?.crossings).toEqual([]);
    });

    it("sorts a member's days before summing them", () => {
        /*
         * Rows arrive in whatever order the query returned them grouped, and a running sum
         * over unordered days credits the wrong day with the crossing — reporting a member
         * who levelled in March as having done it in January.
         */
        const progressions = buildMemberProgressions([
            row('user-1', '2026-03-01', xpForLevel(2)),
            row('user-1', '2026-01-01', 1),
        ]);

        expect(progressions[0]?.firstActivityDate).toBe('2026-01-01');
        expect(progressions[0]?.crossings).toEqual([{ level: 2, days: 59 }]);
    });

    it('counts a zero-XP day as a day present', () => {
        // Every message hit the cooldown. They were here; calling the day absent would
        // flatter the engagement figures.
        const progressions = buildMemberProgressions([
            row('user-1', '2026-01-01', 10),
            row('user-1', '2026-01-02', 0),
        ]);

        expect(progressions[0]?.activeDays).toBe(2);
        expect(progressions[0]?.totalXp).toBe(10);
    });

    it('keeps a member who never left level 1', () => {
        // They belong in every denominator. Dropping them would inflate "percent who reached
        // level 5" by removing the people who did not.
        const progressions = buildMemberProgressions([row('user-1', '2026-01-01', 1)]);

        expect(progressions).toHaveLength(1);
        expect(progressions[0]?.crossings).toEqual([]);
    });

    it('keeps members apart', () => {
        const progressions = buildMemberProgressions([
            row('user-1', '2026-01-01', xpForLevel(2)),
            row('user-2', '2026-01-01', 1),
        ]);

        const byUser = new Map(progressions.map((progression) => [progression.userId, progression]));
        expect(byUser.get('user-1')?.crossings).toHaveLength(1);
        expect(byUser.get('user-2')?.crossings).toHaveLength(0);
    });

    it('returns nothing for no rows', () => {
        expect(buildMemberProgressions([])).toEqual([]);
    });
});
