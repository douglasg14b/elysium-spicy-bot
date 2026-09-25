import { getLevelFromTotalXp } from './xpCalculator';
import { buildMemberProgressions, MAX_TRACKED_LEVEL, type DailyXpRow, type MemberProgression } from './levelCrossings';
import {
    assignCohorts,
    COHORT_KEYS,
    median,
    THIN_COHORT_THRESHOLD,
    type CohortKey,
} from './levelingCohorts';

/**
 * The guild-wide leveling picture, for an operator rather than a member.
 *
 * Pure: takes daily XP rows in and returns every figure the dashboard draws. No database,
 * no Discord, no clock beyond what the caller supplies — so the whole report is testable
 * against a handful of fixture rows, which matters because almost every number here is a
 * statistic that looks plausible when it is wrong.
 */

/** One point on the "how many got there" curve. */
export interface LevelReachPoint {
    readonly level: number;
    /** Members whose XP has ever carried them to this level or beyond. */
    readonly membersReached: number;
    /** 0–100, share of tracked members. Rounded for display; the count is the truth. */
    readonly percentReached: number;
}

/** One cohort's line on the progression chart. */
export interface CohortProgressionPoint {
    readonly level: number;
    /** Typical whole days from first activity to this level. */
    readonly medianDays: number;
    /** Members in this cohort who actually reached it — below the threshold it is a hint. */
    readonly membersReached: number;
    readonly thin: boolean;
}

export interface CohortSummary {
    readonly cohort: CohortKey;
    readonly memberCount: number;
    readonly medianTotalXp: number;
    readonly medianLevel: number;
    readonly medianActiveDays: number;
    /** Ascending by level. Stops where the cohort stops reaching. */
    readonly progression: readonly CohortProgressionPoint[];
}

export interface XpDistribution {
    /**
     * The median member's XP, and the figure to quote.
     *
     * Named `typical` rather than `median` because the point of reporting it beside `mean`
     * is that one of them describes a member and the other does not.
     */
    readonly typicalXp: number;
    readonly meanXp: number;
    /** How many times larger the mean is than the median. The long tail, as one number. */
    readonly meanToTypicalRatio: number;
    readonly topMemberXp: number;
    /** Deciles of XP, lowest first, for the distribution chart. */
    readonly deciles: readonly number[];
}

export interface LevelingInsights {
    readonly trackedMembers: number;
    /**
     * The highest level anybody has actually reached. Unclamped, and null when nobody has
     * earned anything rather than a zero that reads as a real level.
     *
     * Deliberately **not** limited to `MAX_TRACKED_LEVEL` the way {@link levelReach} is:
     * this is a fact about a member, and reporting 50 for somebody at 63 would be a lie
     * told to keep a chart axis tidy. {@link levelReachTruncated} is how the UI knows the
     * curve stops short of this figure, so the two can disagree visibly instead of
     * silently.
     */
    readonly topLevel: number | null;
    /**
     * True when somebody is above `MAX_TRACKED_LEVEL`, so the reach curve ends before
     * {@link topLevel}.
     *
     * Carried rather than left for the UI to infer by comparing the last curve point to
     * `topLevel` — that inference is a rule, and a rule in two places is a rule that
     * disagrees with itself.
     */
    readonly levelReachTruncated: boolean;
    readonly levelReach: readonly LevelReachPoint[];
    readonly cohorts: readonly CohortSummary[];
    readonly xpDistribution: XpDistribution | null;
    /** Earliest and latest activity dates in the window, for the operator's own context. */
    readonly firstActivityDate: string | null;
    readonly lastActivityDate: string | null;
}

function percentOf(count: number, total: number): number {
    return total === 0 ? 0 : Math.round((count / total) * 100);
}

/**
 * Deciles of a sorted list, lowest first.
 *
 * Nine cut points rather than ten buckets: what a distribution chart wants is the value at
 * each 10% mark, which is what makes a long tail visible as a curve that hugs the floor
 * and then leaps.
 *
 * **The index is clamped, and that has a consequence worth knowing at the call site.** With
 * ten or fewer members, `floor(len * 9 / 10)` reaches the last element, so the ninth cut *is*
 * `topMemberXp` rather than a percentile below it. A surface that scales its chart to the
 * ninth cut and tells an operator it therefore excludes their top member would be printing a
 * claim the two numbers beside it contradict. The browser detects this by comparing the two
 * values it was sent rather than by re-deriving this arithmetic — which is the right
 * direction, because this function owns the clamp and nothing else should have an opinion
 * about it.
 */
function deciles(sortedXp: readonly number[]): number[] {
    if (sortedXp.length === 0) {
        return [];
    }

    const cuts: number[] = [];
    for (let decile = 1; decile <= 9; decile++) {
        const index = Math.min(sortedXp.length - 1, Math.floor((sortedXp.length * decile) / 10));
        cuts.push(sortedXp[index]!);
    }

    return cuts;
}

function buildLevelReach(progressions: readonly MemberProgression[]): LevelReachPoint[] {
    const total = progressions.length;
    if (total === 0) {
        return [];
    }

    /*
     * Levels are derived from `totalXp`, never read from `leveling_progress.level`.
     *
     * That column is a write-time cache nothing recomputes, so it lags whenever the curve
     * is tuned — and this chart would then disagree with the progression chart beside it,
     * which is necessarily threshold-derived. One source of truth for "what level is this".
     */
    const levels = progressions.map((progression) => getLevelFromTotalXp(progression.totalXp));
    const highest = Math.min(MAX_TRACKED_LEVEL, Math.max(...levels));

    const points: LevelReachPoint[] = [];

    // From level 2: everybody is level 1, so "100% reached level 1" is noise on a chart.
    for (let level = 2; level <= highest; level++) {
        // Reaching a level means being at it *or beyond* — a member at 12 reached 5.
        const membersReached = levels.filter((memberLevel) => memberLevel >= level).length;
        points.push({
            level,
            membersReached,
            percentReached: percentOf(membersReached, total),
        });
    }

    return points;
}

function buildCohortSummaries(progressions: readonly MemberProgression[]): CohortSummary[] {
    const memberships = assignCohorts(progressions);

    return COHORT_KEYS.map((cohort) => {
        const members = memberships
            .filter((membership) => membership.cohort === cohort)
            .map((membership) => membership.progression);

        const progression: CohortProgressionPoint[] = [];

        for (let level = 2; level <= MAX_TRACKED_LEVEL; level++) {
            const daysToLevel = members
                .map((member) => member.crossings.find((crossing) => crossing.level === level))
                .filter((crossing): crossing is NonNullable<typeof crossing> => !!crossing)
                .map((crossing) => crossing.days);

            if (daysToLevel.length === 0) {
                /*
                 * Stop at the first level nobody in the cohort reached, rather than
                 * skipping it and carrying on. A gap would let a line jump from level 10 to
                 * level 20 as though the climb between them were instant, when the truth is
                 * that the data ends.
                 */
                break;
            }

            progression.push({
                level,
                medianDays: median(daysToLevel) ?? 0,
                membersReached: daysToLevel.length,
                thin: daysToLevel.length < THIN_COHORT_THRESHOLD,
            });
        }

        return {
            cohort,
            memberCount: members.length,
            medianTotalXp: median(members.map((member) => member.totalXp)) ?? 0,
            medianLevel: median(members.map((member) => getLevelFromTotalXp(member.totalXp))) ?? 1,
            medianActiveDays: median(members.map((member) => member.activeDays)) ?? 0,
            progression,
        };
    });
}

function buildXpDistribution(progressions: readonly MemberProgression[]): XpDistribution | null {
    if (progressions.length === 0) {
        return null;
    }

    const sortedXp = progressions.map((progression) => progression.totalXp).sort((left, right) => left - right);
    const typicalXp = median(sortedXp) ?? 0;
    const meanXp = Math.round(sortedXp.reduce((sum, xp) => sum + xp, 0) / sortedXp.length);

    return {
        typicalXp,
        meanXp,
        // Guarded: a server where the median member has earned nothing would divide by zero
        // and report Infinity as a ratio.
        meanToTypicalRatio: typicalXp > 0 ? Math.round((meanXp / typicalXp) * 10) / 10 : 0,
        topMemberXp: sortedXp[sortedXp.length - 1] ?? 0,
        deciles: deciles(sortedXp),
    };
}

/** Build the whole report. */
export function buildLevelingInsights(rows: readonly DailyXpRow[]): LevelingInsights {
    const progressions = buildMemberProgressions(rows);

    const dates = rows.map((row) => row.activityDate).sort((left, right) => left.localeCompare(right));
    const levels = progressions.map((progression) => getLevelFromTotalXp(progression.totalXp));

    const topLevel = levels.length > 0 ? Math.max(...levels) : null;

    return {
        trackedMembers: progressions.length,
        topLevel,
        levelReachTruncated: topLevel !== null && topLevel > MAX_TRACKED_LEVEL,
        levelReach: buildLevelReach(progressions),
        cohorts: buildCohortSummaries(progressions),
        xpDistribution: buildXpDistribution(progressions),
        firstActivityDate: dates[0] ?? null,
        lastActivityDate: dates[dates.length - 1] ?? null,
    };
}
