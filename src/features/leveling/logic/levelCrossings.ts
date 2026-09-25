import { getTotalXpForLevel } from './xpCalculator';

/**
 * When each member crossed each level, reconstructed from their XP history.
 *
 * Nothing stores a level-up date. `leveling_progress` holds only a current total, so the
 * only record of *when* somebody reached level 10 is the event log — and that log can
 * answer it exactly, because `grantXp` writes the event row and the progress row from the
 * same value inside one transaction. `SUM(xpAmount)` therefore equals `progress.totalXp`
 * by construction rather than by luck.
 *
 * Cooldown-blocked grants are recorded with `xpAmount: 0`, so a running sum needs no
 * cooldown awareness: the zeroes are harmless no-ops.
 */

/** One member's XP earned on one day, already bucketed in the leveling timezone. */
export interface DailyXpRow {
    readonly userId: string;
    /** `YYYY-MM-DD` in the configured leveling timezone, not UTC. */
    readonly activityDate: string;
    readonly xpAmount: number;
}

/** A level, and how long after the member's first activity they reached it. */
export interface LevelCrossing {
    readonly level: number;
    /**
     * Whole days from the member's first recorded activity to reaching this level.
     *
     * Days rather than a timestamp because the input is day-bucketed: a same-day climb is
     * zero, which is the honest answer at this resolution and reads correctly on a chart
     * whose x-axis starts at the member's first day.
     */
    readonly days: number;
}

export interface MemberProgression {
    readonly userId: string;
    readonly firstActivityDate: string;
    readonly totalXp: number;
    /**
     * Days on which this member earned anything at all.
     *
     * Counted from the rows rather than inferred from crossings — a member can be active for
     * months without crossing a level, and equally can cross three in one day. Carried here
     * because the daily rows are the only place it is knowable and they are discarded after
     * this pass.
     */
    readonly activeDays: number;
    /** Ascending by level, one entry per level actually reached. */
    readonly crossings: readonly LevelCrossing[];
}

/**
 * Highest level the ladder is computed for.
 *
 * A ceiling rather than "until the XP runs out" so a single absurd outlier cannot stretch
 * every chart axis. The reference server's top member sits at 28; 50 leaves headroom
 * without inviting a 200-entry ladder.
 */
export const MAX_TRACKED_LEVEL = 50;

/**
 * Cumulative XP needed for each level, computed once.
 *
 * `getTotalXpForLevel` loops internally, so calling it per member per level would be
 * quadratic for no reason. Index `n` holds the total for level `n`; index 0 and 1 are both
 * zero, since levels start at 1.
 */
function buildThresholdLadder(): readonly number[] {
    const ladder: number[] = [];
    for (let level = 0; level <= MAX_TRACKED_LEVEL; level++) {
        ladder.push(getTotalXpForLevel(level));
    }
    return ladder;
}

const THRESHOLDS = buildThresholdLadder();

/** Whole days between two `YYYY-MM-DD` keys. */
function daysBetween(fromDate: string, toDate: string): number {
    /*
     * Parsed as UTC midnight deliberately. Both keys were produced by the same
     * timezone-aware bucketer, so the offset is identical on each side and cancels — using
     * UTC here avoids a second timezone opinion and the DST edge that comes with it. The
     * difference between two midnights is a whole number of days.
     */
    const from = Date.parse(`${fromDate}T00:00:00Z`);
    const to = Date.parse(`${toDate}T00:00:00Z`);

    if (Number.isNaN(from) || Number.isNaN(to)) {
        return 0;
    }

    return Math.max(0, Math.round((to - from) / 86_400_000));
}

/**
 * Reconstruct every member's level-crossing timeline from their daily XP.
 *
 * Rows may arrive in any order and are grouped here; within a member they are sorted by
 * date before the cumulative pass, because a running sum over unordered days would credit
 * the wrong day with a crossing.
 *
 * A member appears in the result even if they never left level 1 — their `crossings` is
 * empty, which is a fact about them rather than a reason to omit them from a denominator.
 */
export function buildMemberProgressions(rows: readonly DailyXpRow[]): MemberProgression[] {
    const byMember = new Map<string, DailyXpRow[]>();

    for (const row of rows) {
        const existing = byMember.get(row.userId);
        if (existing) {
            existing.push(row);
        } else {
            byMember.set(row.userId, [row]);
        }
    }

    const progressions: MemberProgression[] = [];

    for (const [userId, memberRows] of byMember) {
        const ordered = [...memberRows].sort((left, right) =>
            left.activityDate.localeCompare(right.activityDate)
        );

        const firstActivityDate = ordered[0]?.activityDate;
        if (!firstActivityDate) {
            continue;
        }

        const crossings: LevelCrossing[] = [];
        let cumulativeXp = 0;
        // The next level whose threshold has not yet been passed. Starts at 2: level 1 is
        // where everybody begins, so "reaching" it took no time and is not a crossing.
        let nextLevel = 2;

        for (const row of ordered) {
            cumulativeXp += row.xpAmount;

            /*
             * A `while`, not an `if`: one busy day can cross several levels at once, and an
             * `if` would record the first and silently swallow the rest — leaving a member
             * who jumped 4→7 looking like they never reached 5 or 6.
             */
            while (nextLevel <= MAX_TRACKED_LEVEL && cumulativeXp >= THRESHOLDS[nextLevel]!) {
                crossings.push({
                    level: nextLevel,
                    days: daysBetween(firstActivityDate, row.activityDate),
                });
                nextLevel++;
            }
        }

        progressions.push({
            userId,
            firstActivityDate,
            totalXp: cumulativeXp,
            /*
             * Rows that earned nothing still count as a day present: a member whose every
             * message hit the cooldown was active, and calling that day absent would flatter
             * the engagement figures. One row is one day by construction, since the caller
             * buckets by date before this sees them.
             */
            activeDays: ordered.length,
            crossings,
        });
    }

    return progressions;
}
