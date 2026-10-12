import { describe, expect, it } from 'vitest';
import {
    COHORT_PRESENTATION,
    PROGRESSION_HEIGHT,
    PROGRESSION_MIN_LEVEL,
    PROGRESSION_WIDTH,
    levelReachView,
    progressionView,
    xpDistributionView,
} from '../levelingInsights';
// Imported from the module that owns them, not forwarded through the one under test: the floor
// and the hairline are one decision and live together.
import { CHART_HEIGHT_PX, EMPTY_BAR_HEIGHT_PX, MIN_VISIBLE_BAR_PERCENT } from '../levelingChart';
import type {
    CohortKey,
    LevelingCohortProgressionPoint,
    LevelingCohortSummary,
    LevelingLevelReachPoint,
    LevelingXpDistribution,
} from '@brattybot/web-sdk';
import { COHORT_KEYS } from '../contractValues';

/**
 * The insights charts' scales. Every one of these can be wrong invisibly — a line scaled
 * against its own extent instead of the shared one still looks like a chart, and a `NaN`
 * coordinate makes an SVG polyline disappear without an error anywhere.
 */

function reachPoint(
    level: number,
    membersReached: number,
    percentReached = 0
): LevelingLevelReachPoint {
    return { level, membersReached, percentReached };
}

/**
 * A progression point with `thin` set **independently** of `membersReached`.
 *
 * Deliberately not `thin: membersReached < 10`. `thin` is the server's own flag — it owns
 * `THIN_COHORT_THRESHOLD` — and re-deriving the threshold here would have these tests prove
 * "the client recomputes it the same way" rather than "the client passes it through". A
 * production regression that replaced the pass-through with a local `< 10` comparison would
 * then keep every one of them green.
 */
function progressionPoint(
    level: number,
    medianDays: number,
    membersReached = 50,
    thin = false
): LevelingCohortProgressionPoint {
    return { level, medianDays, membersReached, thin };
}

function cohort(
    key: CohortKey,
    progression: LevelingCohortProgressionPoint[],
    overrides: Partial<Omit<LevelingCohortSummary, 'cohort' | 'progression'>> = {}
): LevelingCohortSummary {
    return {
        cohort: key,
        memberCount: 40,
        medianTotalXp: 500,
        medianLevel: 4,
        medianActiveDays: 12,
        ...overrides,
        progression,
    };
}

function distribution(
    deciles: number[],
    overrides: Partial<Omit<LevelingXpDistribution, 'deciles'>> = {}
): LevelingXpDistribution {
    return {
        typicalXp: 261,
        meanXp: 2452,
        meanToTypicalRatio: 9.4,
        topMemberXp: 90000,
        ...overrides,
        deciles,
    };
}

describe('levelReachView', () => {
    it('scales every bar against the point the most members reached', () => {
        const view = levelReachView([reachPoint(2, 100), reachPoint(3, 50), reachPoint(4, 25)]);

        expect(view.peakMembers).toBe(100);
        expect(view.bars.map((bar) => bar.heightPercent)).toEqual([100, 50, 25]);
    });

    it('passes the server percentage through untouched rather than recomputing it', () => {
        /*
         * The height and the percentage answer different questions: the height is relative to
         * the tallest bar, the percentage is the share of *tracked members* — which includes
         * everybody who never left level 1 and so is never on the curve. Recomputing it from
         * the counts here would print a share of the curve's own peak and label it a share of
         * the server, which reads high on every guild with a lurker in it.
         */
        const view = levelReachView([reachPoint(2, 40, 8), reachPoint(3, 20, 4)]);

        expect(view.bars.map((bar) => bar.percentReached)).toEqual([8, 4]);
        // The heights are relative to each other, and differ from the percentages precisely
        // because the denominators differ.
        expect(view.bars.map((bar) => bar.heightPercent)).toEqual([100, 50]);
    });

    it('gives a level one person reached a visible sliver', () => {
        // 1/400 rounds to 0% and vanishes, which reads as a level nobody got to.
        const view = levelReachView([reachPoint(2, 400), reachPoint(30, 1)]);

        expect(view.bars[1]?.heightPercent).toBe(MIN_VISIBLE_BAR_PERCENT);
    });

    it('floors the sliver clear of the height an empty bar is drawn at', () => {
        /*
         * Shared with the activity chart deliberately — see `levelingChart.ts`. A 2% floor
         * against a 96px row is 1.92px, which the page's `minHeight: 2` hairline rounds up to
         * exactly 2px, leaving "one member reached this" and "nobody did" the same height.
         * Asserted as the relationship rather than a pixel count so shrinking the row cannot
         * quietly collapse it again.
         */
        expect(MIN_VISIBLE_BAR_PERCENT).toBeGreaterThan((EMPTY_BAR_HEIGHT_PX / CHART_HEIGHT_PX) * 100);
    });

    it('does not divide by a peak of zero', () => {
        const view = levelReachView([reachPoint(2, 0), reachPoint(3, 0)]);

        expect(view.peakMembers).toBe(0);
        expect(view.bars.every((bar) => bar.heightPercent === 0)).toBe(true);
    });

    it('has no highest level on an empty curve', () => {
        // Null rather than 0: zero is not a level, and an axis labelled "level 0" reads as a
        // real answer rather than an absent one.
        const view = levelReachView([]);

        expect(view.bars).toEqual([]);
        expect(view.peakMembers).toBe(0);
        expect(view.highestLevel).toBeNull();
    });

    it('takes the highest level as a max rather than the last element', () => {
        // Nothing in the wire type promises ascending order, and a reversed array would
        // otherwise label the axis with its lowest level.
        const view = levelReachView([reachPoint(9, 3), reachPoint(2, 80)]);

        expect(view.highestLevel).toBe(9);
    });
});

describe('progressionView', () => {
    it('scales every cohort against one shared pair of axes', () => {
        /*
         * The finding this whole module exists for. The bottom half crawls to level 3 in 60
         * days; the top 1% sprints to level 30 in 20. Scaled per-line, both would be drawn as
         * a line across the full width rising to the full height, which inverts the
         * comparison the chart is for.
         */
        const view = progressionView([
            cohort('bottomHalf', [progressionPoint(2, 30), progressionPoint(3, 60)]),
            cohort('topOnePercent', [progressionPoint(2, 2), progressionPoint(30, 20)]),
        ]);

        expect(view.maxLevel).toBe(30);
        expect(view.maxDays).toBe(60);

        const bottom = view.lines.find((line) => line.cohort === 'bottomHalf');
        const top = view.lines.find((line) => line.cohort === 'topOnePercent');

        // The bottom half's line stops near the left edge, because level 3 of 30 is near it.
        expect(bottom?.points[1]?.x).toBeCloseTo((1 / 28) * PROGRESSION_WIDTH, 1);
        // The top 1% reaches the right edge, and sits high on the page because 20 days of 60
        // is quick. Y is inverted, so "high on the page" is a small number.
        expect(top?.points[1]?.x).toBe(PROGRESSION_WIDTH);
        expect(top?.points[1]?.y).toBeCloseTo(PROGRESSION_HEIGHT - (20 / 60) * PROGRESSION_HEIGHT, 1);
        // And the slowest point on either line sits on the floor of the plot.
        expect(bottom?.points[1]?.y).toBe(0);
    });

    it('starts the x axis at the first level the server reports rather than zero', () => {
        // The series begins at level 2 — everybody is level 1 — so a domain from 0 would leave
        // the leftmost slice of the plot permanently blank.
        const view = progressionView([
            cohort('middle', [progressionPoint(PROGRESSION_MIN_LEVEL, 5), progressionPoint(6, 10)]),
        ]);

        expect(view.lines[0]?.points[0]?.x).toBe(0);
    });

    it('keeps a cohort nobody is in, with no points', () => {
        /*
         * Dropped rather than emptied, an absent band reads as a rendering fault. The server
         * always sends all four — `buildCohortSummaries` maps `COHORT_KEYS` — and a fresh
         * guild has nobody in the middle quarter, so this is the normal case on a small
         * server, not an edge one.
         */
        const view = progressionView([
            cohort('bottomHalf', [progressionPoint(2, 10)]),
            cohort('middle', []),
        ]);

        const middle = view.lines.find((line) => line.cohort === 'middle');
        expect(middle).toBeDefined();
        expect(middle?.points).toEqual([]);
        expect(middle?.polyline).toBe('');
        expect(middle?.hasThinPoints).toBe(false);
        expect(view.empty).toBe(false);
    });

    it('draws no polyline for a lone point, so the page falls back to its marker', () => {
        // SVG renders nothing for a single-coordinate `points` attribute, so a cohort that
        // reached exactly level 2 would otherwise be invisible.
        const view = progressionView([cohort('topQuarter', [progressionPoint(2, 4)])]);

        expect(view.lines[0]?.points).toHaveLength(1);
        expect(view.lines[0]?.polyline).toBe('');
    });

    it('pins a flat day domain to mid-height instead of dividing by zero', () => {
        /*
         * Every cohort reaching every level on day zero is a real answer on a server seeded in
         * one sitting. Dividing by a `maxDays` of 0 puts `NaN` in the `points` attribute, and
         * an SVG polyline with one bad coordinate does not draw *at all* — so the chart would
         * vanish silently rather than look wrong.
         */
        const view = progressionView([
            cohort('bottomHalf', [progressionPoint(2, 0), progressionPoint(3, 0)]),
        ]);

        expect(view.maxDays).toBe(0);
        const ys = view.lines[0]?.points.map((point) => point.y) ?? [];
        expect(ys).toEqual([PROGRESSION_HEIGHT / 2, PROGRESSION_HEIGHT / 2]);
        expect(ys.every((value) => Number.isFinite(value))).toBe(true);
        expect(view.lines[0]?.polyline).not.toContain('NaN');
    });

    it('does not divide by a single-level domain', () => {
        // One level across every cohort gives a zero-width x domain. Guarded to a span of 1
        // rather than divided by, for the same NaN reason.
        const view = progressionView([cohort('middle', [progressionPoint(2, 5)])]);

        expect(view.lines[0]?.points[0]?.x).toBe(0);
        expect(Number.isFinite(view.lines[0]?.points[0]?.x ?? NaN)).toBe(true);
    });

    it('is empty when no cohort has a single point', () => {
        const view = progressionView(COHORT_KEYS.map((key) => cohort(key, [])));

        expect(view.empty).toBe(true);
        expect(view.anyThin).toBe(false);
        expect(view.lines).toHaveLength(COHORT_KEYS.length);
    });

    it('is empty when the server sends no cohorts at all', () => {
        const view = progressionView([]);

        expect(view.empty).toBe(true);
        expect(view.lines).toEqual([]);
        expect(view.maxLevel).toBe(0);
    });

    it('carries the thin flag per point and reports it per line and per chart', () => {
        /*
         * A thin point is fewer than ten members: a median time-to-level computed from three
         * people is one person's anecdote wearing a median's clothes. The flag has to survive
         * to the marker that draws it, not just to a caption.
         */
        const view = progressionView([
            cohort('topOnePercent', [
                progressionPoint(2, 3, 40, false),
                progressionPoint(20, 40, 4, true),
            ]),
            cohort('bottomHalf', [progressionPoint(2, 30, 200, false)]),
        ]);

        const top = view.lines.find((line) => line.cohort === 'topOnePercent');
        expect(top?.points.map((point) => point.thin)).toEqual([false, true]);
        expect(top?.hasThinPoints).toBe(true);

        const bottom = view.lines.find((line) => line.cohort === 'bottomHalf');
        expect(bottom?.hasThinPoints).toBe(false);

        expect(view.anyThin).toBe(true);
    });

    it('takes the thin flag from the server rather than recomputing the threshold', () => {
        /*
         * The threshold is `THIN_COHORT_THRESHOLD`, and it lives in the bot. So these two points
         * deliberately **disagree** with a client-side `membersReached < 10`: forty members
         * flagged thin, four not. A production regression that dropped `point.thin` for a local
         * comparison would invert both and fail here, where every other thin assertion in this
         * file would still pass.
         */
        const view = progressionView([
            cohort('middle', [progressionPoint(2, 5, 40, true), progressionPoint(3, 9, 4, false)]),
        ]);

        expect(view.lines[0]?.points.map((point) => point.thin)).toEqual([true, false]);
        expect(view.anyThin).toBe(true);
    });

    it('formats the polyline as SVG coordinate pairs', () => {
        const view = progressionView([
            cohort('bottomHalf', [progressionPoint(2, 0), progressionPoint(3, 10)]),
        ]);

        // Bottom-left to top-right: day 0 at the plot's floor, the slowest at its ceiling.
        expect(view.lines[0]?.polyline).toBe(`0,${PROGRESSION_HEIGHT} ${PROGRESSION_WIDTH},0`);
    });
});

describe('COHORT_PRESENTATION', () => {
    it('covers every cohort the server can send', () => {
        // The compile-time guard is the `Record<CohortKey, …>`; this is the runtime half, so a
        // key added to the server's enum and to the record with a typo still fails here.
        for (const key of COHORT_KEYS) {
            expect(COHORT_PRESENTATION[key].label).toBeTruthy();
            expect(COHORT_PRESENTATION[key].color).toMatch(/^#[0-9A-Fa-f]{6}$/);
        }
    });

    it('gives every cohort a distinct dash pattern, not just a colour', () => {
        /*
         * A second encoding channel. The ramp contains a red/green pair that the commonest form
         * of colour blindness collapses, so four lines separated by hue alone are four lines one
         * reader in twelve cannot tell apart. Null is the solid line and counts as its own
         * pattern, which is why the uniqueness check includes it.
         */
        const dashes = COHORT_KEYS.map((key) => COHORT_PRESENTATION[key].dash);

        expect(new Set(dashes).size).toBe(COHORT_KEYS.length);
    });

    it('marks the top 1% as overlapping and the three bands as not', () => {
        /*
         * `assignCohorts` puts a top-1% member in `topQuarter` as well, so the four counts do
         * not partition the server and summing them over-counts. This flag is what stops the
         * page drawing a stacked total, so it is asserted rather than assumed.
         */
        expect(COHORT_PRESENTATION.topOnePercent.overlapping).toBe(true);
        expect(COHORT_PRESENTATION.topQuarter.overlapping).toBe(false);
        expect(COHORT_PRESENTATION.middle.overlapping).toBe(false);
        expect(COHORT_PRESENTATION.bottomHalf.overlapping).toBe(false);
    });
});

describe('xpDistributionView', () => {
    it('scales the decile bars against the largest cut, not the top member', () => {
        /*
         * `topMemberXp` is typically multiples of the ninetieth percentile on a long-tailed
         * server, and scaling to it crushes all nine bars flat — hiding exactly the shape the
         * chart exists to show.
         */
        const view = xpDistributionView(
            distribution([10, 20, 30, 40, 50, 60, 70, 80, 100], { topMemberXp: 90000 })
        );

        expect(view.bars).toHaveLength(9);
        expect(view.bars[8]?.heightPercent).toBe(100);
        expect(view.bars[4]?.heightPercent).toBe(50);
        // Reported, but not part of the scale.
        expect(view.topMemberXp).toBe(90000);
    });

    it('numbers the bars from the first decile', () => {
        const view = xpDistributionView(distribution([1, 2, 3, 4, 5, 6, 7, 8, 9]));

        expect(view.bars.map((bar) => bar.decile)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
        expect(view.bars.map((bar) => bar.xp)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    });

    it('gives the bottom decile a visible sliver against a long tail', () => {
        // 5/50000 rounds to 0% and reads as "these members have no XP", when they have some.
        const view = xpDistributionView(distribution([5, 100, 400, 900, 2000, 5000, 12000, 25000, 50000]));

        expect(view.bars[0]?.heightPercent).toBe(MIN_VISIBLE_BAR_PERCENT);
    });

    it('flags the mean-over-median gap the reference data shows', () => {
        // Typical 261 against an average of 2,452 — the single most useful figure on the page,
        // because it says the average describes nobody.
        const view = xpDistributionView(
            distribution([12, 40, 96, 150, 261, 480, 900, 2400, 9000], {
                typicalXp: 261,
                meanXp: 2452,
                meanToTypicalRatio: 9.4,
            })
        );

        expect(view.meanExceedsTypical).toBe(true);
        expect(view.typicalXp).toBe(261);
        expect(view.meanXp).toBe(2452);
        expect(view.meanToTypicalRatio).toBe(9.4);
    });

    it('does not flag a gap when the mean equals the median', () => {
        // Strictly greater: an equal pair is symmetric and has nothing to point out. "1.0x"
        // dressed up as a finding is noise.
        const view = xpDistributionView(
            distribution([100, 100, 100, 100, 100, 100, 100, 100, 100], {
                typicalXp: 100,
                meanXp: 100,
                meanToTypicalRatio: 1,
            })
        );

        expect(view.meanExceedsTypical).toBe(false);
    });

    it('admits when the top cut is the top member', () => {
        /*
         * The boundary the previous copy on this page denied. The server's cut index is
         * `Math.min(len - 1, Math.floor((len * decile) / 10))`, so at ten or fewer tracked
         * members the ninth decile clamps onto the last element — which *is* `topMemberXp`.
         *
         * Checked directly: len=9 → index 8 of 8, len=10 → index 9 of 9, len=11 → index 9 of 10.
         * So the scale stops excluding the top member exactly at ten, and the caption claiming it
         * does was false on every small guild while the figure printed beside the chart showed
         * the same number as the full-height bar.
         */
        const view = xpDistributionView(
            distribution([5, 20, 60, 120, 300, 700, 1500, 4000, 9000], { topMemberXp: 9000 })
        );

        expect(view.topCutIsTopMember).toBe(true);
        expect(view.bars[8]?.xp).toBe(view.topMemberXp);
    });

    it('does not claim the top cut is the top member on a long tail', () => {
        // The normal case: eleven or more members, so the ninth cut sits below the top member and
        // the scale genuinely excludes them.
        const view = xpDistributionView(
            distribution([5, 20, 60, 120, 300, 700, 1500, 4000, 9000], { topMemberXp: 90000 })
        );

        expect(view.topCutIsTopMember).toBe(false);
    });

    it('does not call an all-zero distribution top-member-scaled', () => {
        // Both are zero, so they are equal — but there is no top member to exclude and no scale
        // to describe. Guarded on `peak > 0` so the caption does not claim a whale at the top of
        // an empty chart.
        const view = xpDistributionView(
            distribution([0, 0, 0, 0, 0, 0, 0, 0, 0], { typicalXp: 0, topMemberXp: 0 })
        );

        expect(view.topCutIsTopMember).toBe(false);
        expect(view.allZero).toBe(true);
    });

    it('does not divide by an all-zero distribution', () => {
        // A guild where every member below the 90th percentile has earned nothing. The bars
        // are all zero rather than `NaN%` in a style attribute, and `allZero` lets the page
        // say so instead of drawing an empty row.
        const view = xpDistributionView(distribution([0, 0, 0, 0, 0, 0, 0, 0, 0], { typicalXp: 0 }));

        expect(view.bars.every((bar) => bar.heightPercent === 0)).toBe(true);
        expect(view.allZero).toBe(true);
    });

    it('does not call an absent distribution all-zero', () => {
        // No cuts at all is a different sentence from cuts that are all zero — the server
        // sends an empty array only when there is nobody to take a decile of.
        const view = xpDistributionView(distribution([]));

        expect(view.bars).toEqual([]);
        expect(view.allZero).toBe(false);
    });
});
