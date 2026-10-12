/**
 * The insights page's four charts, as numbers, with no charting dependency.
 *
 * Every scale here is a decision with a degenerate case behind it — an empty guild, a single
 * point, a cohort nobody is in, a denominator of zero — and a chart computed inside JSX is a
 * chart only a render can check. So the page maps the results
 * of this module to divs and polylines and holds no arithmetic of its own.
 *
 * **Several of these figures are easy to misrepresent, and the types say so rather than
 * trusting a reader to remember.** `topOnePercent` overlaps `topQuarter` by design, so there
 * is deliberately no function here that sums cohort member counts. A `thin` point is fewer
 * than ten members and is carried through to every view that could draw it.
 */

import type {
    CohortKey,
    LevelingCohortSummary,
    LevelingLevelReachPoint,
    LevelingXpDistribution,
} from '@brattybot/web-sdk';
import { MIN_VISIBLE_BAR_PERCENT } from './levelingChart';

/**
 * The member count below which a progression point is a hint rather than a fact.
 *
 * Mirrored from `THIN_COHORT_THRESHOLD` in `src/features/leveling/logic/levelingCohorts.ts`,
 * which is where it is **decided** — the server sets each point's `thin` flag and this side
 * renders it, so the number here is only ever used to *say* the threshold in a caption. Named
 * rather than written as "ten" in five sentences: if the bot moves it to 25 the markers stay
 * correct and every caption silently becomes a lie, which is the failure mode a literal invites.
 */
export const THIN_COHORT_MEMBERS = 10;

/* ---- Cohort presentation ---- */

export interface CohortPresentation {
    /** The bot's own word for the band, verbatim from `COHORT_LABELS`. */
    readonly label: string;
    /** A CSS colour for the line and the legend swatch. */
    readonly color: string;
    /**
     * An SVG `stroke-dasharray`, or null for a solid line.
     *
     * A second channel beside the colour, because the four-line chart otherwise distinguishes
     * bands by hue alone — and the ramp includes a red/green pair that the commonest form of
     * colour blindness collapses into one another. The `thin` markers already encode by shape;
     * the lines had no equivalent.
     */
    readonly dash: string | null;
    /**
     * Whether this band overlaps another, so a total is not a total.
     *
     * Carried as a flag rather than left to the page to special-case `topOnePercent` by name:
     * the overlap is a property of the cohort, and a second cohort gaining it later would
     * otherwise need the page edited too.
     */
    readonly overlapping: boolean;
}

/**
 * Every cohort, exhaustively.
 *
 * A `Record<CohortKey, …>` rather than a lookup with a fallback: `CohortKey` is generated
 * from the route's own enum, so a fifth cohort the server starts reporting is a **compile
 * error** here after `pnpm sdk:generate` instead of a line drawn in undefined colour with
 * the label `undefined`.
 *
 * Labels are `COHORT_LABELS`' verbatim — an operator reading "Middle quarter" in Discord and
 * "Middle" on the dashboard would reasonably wonder whether they were different bands.
 * Colours run cool to hot with activity, and are Mantine ramp values rather than CSS
 * variables because they are also needed as SVG `stroke` attributes.
 */
export const COHORT_PRESENTATION: Readonly<Record<CohortKey, CohortPresentation>> = {
    bottomHalf: { label: 'Bottom half', color: '#4C6EF5', dash: '2 3', overlapping: false },
    middle: { label: 'Middle quarter', color: '#12B886', dash: '6 3', overlapping: false },
    topQuarter: { label: 'Top quarter', color: '#FAB005', dash: '10 4', overlapping: false },
    /*
     * The one that is not a band. `assignCohorts` puts its members in `topQuarter` *as well*,
     * because the reference report spotlights the extreme tail separately — their numbers sit
     * so far outside everyone else's that folding them into the top quarter's median hides
     * both stories. Summing the four counts therefore over-counts the server on purpose.
     */
    topOnePercent: { label: 'Top 1%', color: '#FA5252', dash: null, overlapping: true },
};

/* ---- Level reach ---- */

export interface LevelReachBar {
    readonly level: number;
    readonly membersReached: number;
    /** 0–100, the server's own share of tracked members. */
    readonly percentReached: number;
    /** 0–100, height as a share of the tallest bar in this chart. */
    readonly heightPercent: number;
}

export interface LevelReachView {
    readonly bars: readonly LevelReachBar[];
    /** The most members any single point holds, so the chart can label full height. */
    readonly peakMembers: number;
    /** The last level anybody on the curve reached, for the axis label. */
    readonly highestLevel: number | null;
}

/**
 * Scale the reach curve into drawable bars.
 *
 * Scaled to the **peak point's member count**, not to `trackedMembers`, and not to the
 * percentage. The curve starts at level 2 — everybody is level 1, so the server omits it —
 * which means the first point is already below the tracked total on any server where somebody
 * never levelled. Scaling against the tracked total would draw every bar in the bottom
 * fraction of the row and flatten the shape the chart exists to show; scaling against the
 * peak makes the drop-off legible, and `peakMembers` is reported so the page can say what
 * full height is worth.
 *
 * `percentReached` is passed through untouched rather than recomputed from the counts: the
 * server rounds it, and a second rounding this side would print a figure the API did not send.
 * It is **not** the bar height — the height is relative to the peak, the percentage is
 * relative to the server.
 *
 * The floor is {@link MIN_VISIBLE_BAR_PERCENT}, shared with the activity chart rather than
 * chosen again: one member against a peak of four hundred rounds to 0% and vanishes, which
 * reads as a level nobody reached, and the two floors have to stay clear of the same
 * hairline. See that module's comment for why a second number here would be a bug.
 */
export function levelReachView(points: readonly LevelingLevelReachPoint[]): LevelReachView {
    const peakMembers = points.reduce((highest, point) => Math.max(highest, point.membersReached), 0);

    const bars = points.map((point) => ({
        level: point.level,
        membersReached: point.membersReached,
        percentReached: point.percentReached,
        heightPercent:
            peakMembers > 0 && point.membersReached > 0
                ? Math.max(Math.round((point.membersReached / peakMembers) * 100), MIN_VISIBLE_BAR_PERCENT)
                : 0,
    }));

    return {
        bars,
        peakMembers,
        // The curve is ascending by level, but a max rather than the last element: nothing in
        // the wire type promises the order, and a reversed array would otherwise label the
        // axis with its lowest level.
        highestLevel: points.length > 0 ? points.reduce((highest, point) => Math.max(highest, point.level), 0) : null,
    };
}

/* ---- Cohort progression ---- */

/** The plot area the progression lines are projected into, in SVG user units. */
export const PROGRESSION_WIDTH = 600;
export const PROGRESSION_HEIGHT = 220;

/**
 * The level the x axis starts at.
 *
 * Two, matching the server: `buildCohortSummaries` iterates from level 2 because reaching
 * level 1 costs nothing and every member has done it.
 */
export const PROGRESSION_MIN_LEVEL = 2;

/** One cohort's plotted point, in SVG coordinates. */
export interface ProgressionPlotPoint {
    readonly level: number;
    readonly medianDays: number;
    readonly membersReached: number;
    /** Fewer than ten members reached this level: one person's climb, not a typical time. */
    readonly thin: boolean;
    readonly x: number;
    readonly y: number;
}

export interface ProgressionLine {
    readonly cohort: CohortKey;
    readonly presentation: CohortPresentation;
    readonly points: readonly ProgressionPlotPoint[];
    /** `points` as an SVG `points` attribute. Empty string when there is nothing to draw. */
    readonly polyline: string;
    /** True when any point on this line is thin, so the legend can mark the whole line. */
    readonly hasThinPoints: boolean;
}

export interface ProgressionView {
    /** One per cohort, in `COHORT_KEYS` order. A cohort with no data has no points. */
    readonly lines: readonly ProgressionLine[];
    /** The shared x domain: the highest level any cohort reached. */
    readonly maxLevel: number;
    /** The shared y domain: the largest median-days figure on any line. */
    readonly maxDays: number;
    /** True when no cohort has a single plottable point. */
    readonly empty: boolean;
    /** True when any line anywhere carries a thin point, so the chart can caption it once. */
    readonly anyThin: boolean;
}

/**
 * Project every cohort's progression onto one shared pair of axes.
 *
 * **The domains are computed across all cohorts before any line is plotted**, and that is the
 * whole reason this is a function rather than a `map` in the page. The lines stop at different
 * levels — a cohort's series ends at the first level nobody in it reached — so scaling each
 * line to its own extent would draw the bottom half's slow crawl to level 5 and the top 1%'s
 * sprint to level 40 as the same shape, which inverts the comparison the chart is for.
 *
 * A cohort with no points is kept in the output with an empty `points` array rather than
 * dropped: the legend lists every band, and a band silently missing from it reads as a
 * rendering fault rather than as "nobody is in it".
 *
 * `y` is inverted (SVG's origin is top-left) so more days is lower on the page, which is the
 * direction a reader expects of a time axis. A single point, or a set where every median is
 * the same, gives a zero-width domain — both are pinned to mid-height rather than divided by,
 * because a `NaN` in a `points` attribute drops the polyline silently.
 */
export function progressionView(cohorts: readonly LevelingCohortSummary[]): ProgressionView {
    const allPoints = cohorts.flatMap((cohort) => cohort.progression);

    const maxLevel = allPoints.reduce((highest, point) => Math.max(highest, point.level), 0);
    const maxDays = allPoints.reduce((highest, point) => Math.max(highest, point.medianDays), 0);

    /*
     * Level 2 is the x origin, not zero. The server's series starts at 2 — everybody is level
     * 1 — so a domain from 0 would leave the leftmost fifth of the plot permanently blank and
     * squeeze every line into what remains.
     */
    const levelSpan = Math.max(1, maxLevel - PROGRESSION_MIN_LEVEL);

    const lines = cohorts.map((cohort) => {
        const presentation = COHORT_PRESENTATION[cohort.cohort];

        const points = cohort.progression.map((point) => {
            const x = ((point.level - PROGRESSION_MIN_LEVEL) / levelSpan) * PROGRESSION_WIDTH;
            /*
             * A flat domain sits at mid-height. `maxDays === 0` means every cohort reached
             * every level the day they arrived, which is a real answer on a fresh server, and
             * dividing by it would put `NaN` in the `points` attribute — an SVG polyline with
             * one bad coordinate does not draw at all, so the chart would silently vanish
             * rather than look wrong.
             */
            const y =
                maxDays > 0
                    ? PROGRESSION_HEIGHT - (point.medianDays / maxDays) * PROGRESSION_HEIGHT
                    : PROGRESSION_HEIGHT / 2;

            return {
                level: point.level,
                medianDays: point.medianDays,
                membersReached: point.membersReached,
                thin: point.thin,
                x: round(x),
                y: round(y),
            };
        });

        return {
            cohort: cohort.cohort,
            presentation,
            points,
            /*
             * A lone point gets no polyline: SVG draws nothing for a single-coordinate
             * `points` attribute, so the page renders a circle for every point regardless and
             * this string is only the joining line. Emitting one anyway would leave a cohort
             * that reached exactly level 2 invisible.
             */
            polyline: points.length > 1 ? points.map((point) => `${point.x},${point.y}`).join(' ') : '',
            hasThinPoints: points.some((point) => point.thin),
        };
    });

    return {
        lines,
        maxLevel,
        maxDays,
        empty: allPoints.length === 0,
        anyThin: allPoints.some((point) => point.thin),
    };
}

/** Two decimals is plenty for an SVG coordinate, and keeps the `points` attribute readable. */
function round(value: number): number {
    return Math.round(value * 100) / 100;
}

/* ---- XP distribution ---- */

export interface XpDecileBar {
    /** 1–9. The share of members at or below this cut, as a decile number. */
    readonly decile: number;
    /** The XP value at this cut. */
    readonly xp: number;
    /** 0–100, height as a share of the largest cut in this chart. */
    readonly heightPercent: number;
}

export interface XpDistributionView {
    readonly bars: readonly XpDecileBar[];
    readonly typicalXp: number;
    readonly meanXp: number;
    /** How many times the mean exceeds the median. The long tail, as one number. */
    readonly meanToTypicalRatio: number;
    readonly topMemberXp: number;
    /**
     * True when the mean sits above the median, i.e. a handful of members are carrying the
     * average.
     *
     * A comparison rather than a formatted sentence, so the page owns the wording and this
     * module owns the decision. Strictly greater: an equal pair is a symmetric distribution
     * with nothing to point out, and "1.0x" dressed up as a finding is noise.
     */
    readonly meanExceedsTypical: boolean;
    /** True when every decile cut is zero, so the bars would all be invisible. */
    readonly allZero: boolean;
    /**
     * True when the tallest bar **is** the top member, so the scale does not exclude them.
     *
     * Derived rather than assumed absent. The server's cut index is
     * `Math.min(len - 1, Math.floor((len * decile) / 10))`, so on a guild with **ten or fewer**
     * tracked members the ninth cut clamps onto the last element — which is `topMemberXp`
     * itself. A caption promising the chart is scaled against the 90th percentile "and not your
     * top member" is then false, and visibly so: the figure printed beside the chart is the same
     * number as the full-height bar.
     */
    readonly topCutIsTopMember: boolean;
}

/**
 * Scale the decile cuts into drawable bars.
 *
 * **Nine bars, not ten.** The server sends nine *cut points* — the XP value at each 10% mark
 * — rather than ten bucket totals, so a bar is "the member at the Nth decile has this much",
 * and a tenth bar would be the top member, which is already reported on its own.
 *
 * Scaled to the largest cut, which on a long-tailed server is the 90th percentile and not the
 * top member: `topMemberXp` is typically multiples of it, and including it in the scale
 * crushes the other eight bars flat — which hides precisely the shape this chart is for. The
 * top member's XP is reported beside the chart as a number instead.
 *
 * **On a guild of ten or fewer that separation does not exist**, because the server's cut index
 * clamps the ninth decile onto the last element. {@link XpDistributionView.topCutIsTopMember}
 * reports it so the page can drop the claim rather than print a sentence the numbers beside it
 * contradict — the scale is still the right one, it simply is not excluding anybody.
 *
 * `MIN_VISIBLE_BAR_PERCENT` again, for the same reason as both other charts: the first decile
 * against a ninetieth that is a hundred times larger rounds to 0% and reads as "these members
 * have no XP", when the truth is that they have a little.
 */
export function xpDistributionView(distribution: LevelingXpDistribution): XpDistributionView {
    const peak = distribution.deciles.reduce((highest, xp) => Math.max(highest, xp), 0);

    const bars = distribution.deciles.map((xp, index) => ({
        decile: index + 1,
        xp,
        heightPercent:
            peak > 0 && xp > 0 ? Math.max(Math.round((xp / peak) * 100), MIN_VISIBLE_BAR_PERCENT) : 0,
    }));

    return {
        bars,
        typicalXp: distribution.typicalXp,
        meanXp: distribution.meanXp,
        meanToTypicalRatio: distribution.meanToTypicalRatio,
        topMemberXp: distribution.topMemberXp,
        meanExceedsTypical: distribution.meanXp > distribution.typicalXp,
        allZero: distribution.deciles.length > 0 && peak === 0,
        /*
         * Compared against the reported top member rather than recomputed from the guild's size,
         * which this side does not have: `trackedMembers` counts members, `deciles` is what the
         * server chose to cut, and inferring one from the other would be a second opinion about
         * an arithmetic the server owns. Equality is the observable fact, and it is the one the
         * caption turns on.
         */
        topCutIsTopMember: peak > 0 && peak === distribution.topMemberXp,
    };
}

/*
 * No re-export of the chart heights here, deliberately.
 *
 * This module imports `MIN_VISIBLE_BAR_PERCENT` from `levelingChart` to scale with, and the page
 * imports `CHART_HEIGHT_PX` and `EMPTY_BAR_HEIGHT_PX` from the same place. Forwarding them would
 * give those constants two import paths and cost a maintainer a second hop when grepping for
 * consumers before changing one — which is precisely the audit their docstrings exist to
 * support, the floor and the hairline having been broken against each other once already.
 */
