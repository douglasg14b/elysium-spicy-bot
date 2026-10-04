import type { MemberProgression } from './levelCrossings';

/**
 * The bands an operator reads a server by.
 *
 * Defined by **rank, not by absolute activity**, so "top quarter" means busiest on this
 * server rather than busy in any general sense. A quiet guild's top quarter may post less
 * than another guild's bottom half, and saying so is the whole point of ranking.
 *
 * Ordered least to most active, because that is the order a stacked reading of a server
 * goes in and the order the chart legend lists.
 */
export const COHORT_KEYS = ['bottomHalf', 'middle', 'topQuarter', 'topOnePercent'] as const;

export type CohortKey = (typeof COHORT_KEYS)[number];

/**
 * Every cohort's label. The `Record` annotation is the guard: a cohort added to
 * {@link COHORT_KEYS} without a label here fails to compile at this literal, and the
 * runtime test "labels every cohort" fails in the suite.
 */
export const COHORT_LABELS: Readonly<Record<CohortKey, string>> = {
    bottomHalf: 'Bottom half',
    middle: 'Middle quarter',
    topQuarter: 'Top quarter',
    topOnePercent: 'Top 1%',
};

/**
 * Below this many members in a cohort, its figures are a hint rather than a fact.
 *
 * The reference report marks any point reached by fewer than ten members, for a good
 * reason: a "typical time to level 20" computed from three people is one person's
 * anecdote wearing a median's clothes. Carried on the wire so the UI can mark it rather
 * than each surface inventing its own threshold.
 */
export const THIN_COHORT_THRESHOLD = 10;

export interface CohortMembership {
    readonly cohort: CohortKey;
    readonly progression: MemberProgression;
}

/**
 * Assign members to cohorts by XP rank.
 *
 * **`topOnePercent` deliberately overlaps `topQuarter`.** It is a spotlight on the extreme
 * tail, not a fifth exclusive band — the reference report shows its top fifteen separately
 * *because* their numbers sit so far outside everyone else's that including them in the
 * top quarter's median hides both stories. Callers summing cohort sizes to a total will
 * over-count, which is why `CohortSummary` (in `buildLevelingInsights`) reports each
 * cohort's own `memberCount` rather than a share of one denominator.
 *
 * Ranked on `totalXp` descending. Ties are broken by `userId` only to keep the assignment
 * deterministic across runs; a tie at a boundary is arbitrary either way.
 */
export function assignCohorts(progressions: readonly MemberProgression[]): CohortMembership[] {
    const ranked = [...progressions].sort(
        (left, right) => right.totalXp - left.totalXp || left.userId.localeCompare(right.userId)
    );

    const total = ranked.length;
    if (total === 0) {
        return [];
    }

    /*
     * Boundaries by count, rounded so every member lands somewhere.
     *
     * `Math.ceil` on the top-1% cut guarantees at least one member whenever anybody is
     * tracked — a floor would make "top 1%" empty for every guild under 100 members, which
     * is most of them, and an empty cohort reads as "no data" rather than "one person".
     */
    const topOnePercentCut = Math.max(1, Math.ceil(total * 0.01));
    const topQuarterCut = Math.max(1, Math.ceil(total * 0.25));
    const middleCut = Math.max(topQuarterCut, Math.ceil(total * 0.5));

    const memberships: CohortMembership[] = [];

    ranked.forEach((progression, index) => {
        if (index < topOnePercentCut) {
            // In both the spotlight and the band it belongs to, by design.
            memberships.push({ cohort: 'topOnePercent', progression });
        }

        if (index < topQuarterCut) {
            memberships.push({ cohort: 'topQuarter', progression });
        } else if (index < middleCut) {
            memberships.push({ cohort: 'middle', progression });
        } else {
            memberships.push({ cohort: 'bottomHalf', progression });
        }
    });

    return memberships;
}

/** The median of a numeric list, or null when there is nothing to take a median of. */
export function median(values: readonly number[]): number | null {
    if (values.length === 0) {
        return null;
    }

    const sorted = [...values].sort((left, right) => left - right);
    const middle = Math.floor(sorted.length / 2);

    return sorted.length % 2 === 0
        ? Math.round((sorted[middle - 1]! + sorted[middle]!) / 2)
        : sorted[middle]!;
}
