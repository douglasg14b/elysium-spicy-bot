import { describe, expect, it } from 'vitest';
import { buildLevelingInsights } from '../buildLevelingInsights';
import { MAX_TRACKED_LEVEL, type DailyXpRow } from '../levelCrossings';
import { getTotalXpForLevel } from '../xpCalculator';

/**
 * The guild-wide report an operator reads as fact.
 *
 * Every figure here is a statistic, and a statistic looks plausible when it is wrong — so
 * these cases target the ones a reasonable implementation gets subtly different: whether
 * "reached level 5" includes members above 5, whether an empty guild produces zeroes or
 * nulls, and whether the mean and the median are the right way round.
 */

function row(userId: string, activityDate: string, xpAmount: number): DailyXpRow {
    return { userId, activityDate, xpAmount };
}

/** A member sitting exactly at `level` on a single day. */
function memberAt(userId: string, level: number): DailyXpRow {
    return row(userId, '2026-01-01', getTotalXpForLevel(level));
}

describe('buildLevelingInsights', () => {
    describe('an empty guild', () => {
        const insights = buildLevelingInsights([]);

        it('reports no members rather than failing', () => {
            expect(insights.trackedMembers).toBe(0);
            expect(insights.levelReach).toEqual([]);
        });

        it('reports null where a zero would read as a real figure', () => {
            // Level 0 does not exist and an XP distribution over nobody is not a distribution.
            // Both would render as confident numbers about an empty server.
            expect(insights.topLevel).toBeNull();
            expect(insights.xpDistribution).toBeNull();
            expect(insights.firstActivityDate).toBeNull();
        });

        it('still reports every cohort, each empty', () => {
            // A missing cohort would drop a line from the chart's legend, which reads as a
            // rendering fault rather than as an empty server.
            expect(insights.cohorts).toHaveLength(4);
            expect(insights.cohorts.every((cohort) => cohort.memberCount === 0)).toBe(true);
        });
    });

    describe('level reach', () => {
        it('counts a member as having reached every level at or below theirs', () => {
            /*
             * The cumulative reading, and the one an operator means. A member at level 10 did
             * reach level 5; counting only members *at* each level would report the share who
             * stopped there, which is a different and much less useful question.
             */
            const insights = buildLevelingInsights([memberAt('high', 10), memberAt('low', 3)]);

            const reach = new Map(insights.levelReach.map((point) => [point.level, point]));
            expect(reach.get(2)?.membersReached).toBe(2);
            expect(reach.get(3)?.membersReached).toBe(2);
            expect(reach.get(4)?.membersReached).toBe(1);
            expect(reach.get(10)?.membersReached).toBe(1);
        });

        it('starts at level 2, since everybody is level 1', () => {
            const insights = buildLevelingInsights([memberAt('one', 5)]);

            expect(insights.levelReach[0]?.level).toBe(2);
        });

        it('reports the share as a percentage of tracked members', () => {
            const insights = buildLevelingInsights([
                memberAt('a', 5),
                memberAt('b', 2),
                memberAt('c', 2),
                memberAt('d', 2),
            ]);

            const reach = new Map(insights.levelReach.map((point) => [point.level, point]));
            expect(reach.get(2)?.percentReached).toBe(100);
            expect(reach.get(5)?.percentReached).toBe(25);
        });

        it('stops the curve at the tracked ceiling but still reports the real top level', () => {
            /*
             * The two figures are allowed to disagree, and `levelReachTruncated` is what says
             * so. Clamping `topLevel` to keep the axis tidy would be a lie about a member;
             * extending the curve to an outlier's level would squash every other bar flat.
             */
            const insights = buildLevelingInsights([memberAt('outlier', MAX_TRACKED_LEVEL + 5)]);

            expect(insights.topLevel).toBe(MAX_TRACKED_LEVEL + 5);
            expect(insights.levelReachTruncated).toBe(true);
            expect(insights.levelReach[insights.levelReach.length - 1]?.level).toBe(MAX_TRACKED_LEVEL);
        });

        it('does not claim truncation for a guild inside the ceiling', () => {
            const insights = buildLevelingInsights([memberAt('normal', 12)]);

            expect(insights.levelReachTruncated).toBe(false);
        });
    });

    describe('xp distribution', () => {
        it('reports the median separately from the mean', () => {
            /*
             * The whole point of the panel. One loud member drags the mean far above anything
             * a real member has, which is why the operator-facing advice is to quote the
             * typical figure — so the two must not be computed from each other or confused.
             */
            const insights = buildLevelingInsights([
                row('quiet-1', '2026-01-01', 10),
                row('quiet-2', '2026-01-01', 10),
                row('quiet-3', '2026-01-01', 10),
                row('loud', '2026-01-01', 100_000),
            ]);

            expect(insights.xpDistribution?.typicalXp).toBe(10);
            expect(insights.xpDistribution?.meanXp).toBe(25_008);
            expect(insights.xpDistribution?.topMemberXp).toBe(100_000);
            expect(insights.xpDistribution?.meanToTypicalRatio).toBeGreaterThan(1_000);
        });

        it('reports nine decile cut points', () => {
            const insights = buildLevelingInsights(
                Array.from({ length: 50 }, (_unused, index) => row(`user-${index}`, '2026-01-01', index + 1))
            );

            expect(insights.xpDistribution?.deciles).toHaveLength(9);
            // Ascending, or the distribution chart draws backwards.
            const deciles = insights.xpDistribution?.deciles ?? [];
            expect([...deciles].sort((left, right) => left - right)).toEqual([...deciles]);
        });

        it('clamps the top decile onto the top member on a small guild', () => {
            /*
             * Pinned because the browser depends on it. With ten or fewer members the ninth cut
             * index reaches the last element, so the top decile *is* `topMemberXp` — and the
             * insights page drops its "scaled against the 90th percentile, not your top member"
             * caption precisely when it detects that equality.
             *
             * It detects it by comparing the two values it was sent rather than by re-deriving
             * this arithmetic, which is the right direction. This test is what makes that
             * equality a property of the server rather than a coincidence the page relies on.
             */
            const insights = buildLevelingInsights(
                Array.from({ length: 8 }, (_unused, index) => row(`user-${index}`, '2026-01-01', (index + 1) * 100))
            );

            const distribution = insights.xpDistribution;
            expect(distribution?.deciles[8]).toBe(distribution?.topMemberXp);
        });

        it('keeps the top decile below the top member once the guild is large enough', () => {
            // The other side of the boundary, so the test above is pinning a clamp rather than
            // an identity that holds for every guild.
            const insights = buildLevelingInsights(
                Array.from({ length: 40 }, (_unused, index) => row(`user-${index}`, '2026-01-01', (index + 1) * 100))
            );

            const distribution = insights.xpDistribution;
            expect(distribution?.deciles[8]).toBeLessThan(distribution?.topMemberXp ?? 0);
        });

        it('does not divide by a zero median', () => {
            // A server where the median member earned nothing would otherwise report Infinity
            // as a ratio, which renders as the string "Infinity" on a stat tile.
            const insights = buildLevelingInsights([
                row('nothing-1', '2026-01-01', 0),
                row('nothing-2', '2026-01-01', 0),
            ]);

            expect(insights.xpDistribution?.typicalXp).toBe(0);
            expect(insights.xpDistribution?.meanToTypicalRatio).toBe(0);
        });
    });

    describe('cohort progression', () => {
        it('stops a cohort line where the cohort stops reaching', () => {
            /*
             * A gap would let the line jump from level 3 to level 9 as though the climb
             * between were instant, when the truth is that the data ends. Breaking is the
             * honest rendering.
             */
            const insights = buildLevelingInsights([memberAt('only', 4)]);
            const topQuarter = insights.cohorts.find((cohort) => cohort.cohort === 'topQuarter');

            expect(topQuarter?.progression.map((point) => point.level)).toEqual([2, 3, 4]);
        });

        it('marks a thin cohort point rather than presenting it as typical', () => {
            // One person's climb is an anecdote wearing a median's clothes. The flag is what
            // lets the UI say so instead of drawing it like everything else.
            const insights = buildLevelingInsights([memberAt('only', 3)]);
            const topQuarter = insights.cohorts.find((cohort) => cohort.cohort === 'topQuarter');

            expect(topQuarter?.progression.every((point) => point.thin)).toBe(true);
        });

        it('counts active days from the rows, not from crossings', () => {
            // A member can be active for months without crossing a level. Inferring days from
            // crossings would report this member as having been present twice.
            const insights = buildLevelingInsights([
                row('steady', '2026-01-01', 5),
                row('steady', '2026-01-02', 5),
                row('steady', '2026-01-03', 5),
            ]);
            const cohort = insights.cohorts.find((entry) => entry.cohort === 'topQuarter');

            expect(cohort?.medianActiveDays).toBe(3);
        });
    });

    it('reports the window it covers', () => {
        const insights = buildLevelingInsights([
            row('user-1', '2026-03-09', 5),
            row('user-1', '2026-01-02', 5),
        ]);

        expect(insights.firstActivityDate).toBe('2026-01-02');
        expect(insights.lastActivityDate).toBe('2026-03-09');
    });
});
