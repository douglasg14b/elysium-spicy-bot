import { describe, expect, it } from 'vitest';
import { assignCohorts, median, COHORT_KEYS, COHORT_LABELS } from '../levelingCohorts';
import type { MemberProgression } from '../levelCrossings';

/**
 * Sorting members into the bands an operator reads a server by.
 *
 * The interesting cases are all at the edges: a one-member server, where every percentile
 * boundary collapses onto the same person, and the deliberate overlap between `topQuarter`
 * and `topOnePercent`, which a reader summing cohort sizes would otherwise treat as a bug.
 */

function member(userId: string, totalXp: number): MemberProgression {
    return { userId, firstActivityDate: '2026-01-01', totalXp, activeDays: 1, crossings: [] };
}

/** `count` members with descending XP, so rank is obvious from the id. */
function ranked(count: number): MemberProgression[] {
    return Array.from({ length: count }, (_unused, index) =>
        member(`user-${index + 1}`, (count - index) * 100)
    );
}

function cohortOf(memberships: ReturnType<typeof assignCohorts>, userId: string): string[] {
    return memberships
        .filter((membership) => membership.progression.userId === userId)
        .map((membership) => membership.cohort)
        .sort();
}

describe('assignCohorts', () => {
    it('puts the top member in both the top quarter and the top 1%', () => {
        /*
         * The overlap is the design, not a leak. `topOnePercent` is a spotlight on the tail
         * rather than a fifth exclusive band — the reference report shows its top fifteen
         * separately *because* including them in the top quarter's median hides both stories.
         */
        const memberships = assignCohorts(ranked(100));

        expect(cohortOf(memberships, 'user-1')).toEqual(['topOnePercent', 'topQuarter']);
    });

    it('assigns each member to exactly one of the three exclusive bands', () => {
        // Whatever the spotlight does, the three bands must partition the server — a member
        // in none of them would vanish from every denominator.
        const memberships = assignCohorts(ranked(100));
        const exclusive = COHORT_KEYS.filter((cohort) => cohort !== 'topOnePercent');

        for (let index = 1; index <= 100; index++) {
            const bands = cohortOf(memberships, `user-${index}`).filter((cohort) =>
                exclusive.includes(cohort as (typeof exclusive)[number])
            );
            expect(bands).toHaveLength(1);
        }
    });

    it('splits a hundred members a quarter, a quarter, a half', () => {
        const memberships = assignCohorts(ranked(100));
        const size = (cohort: string) =>
            memberships.filter((membership) => membership.cohort === cohort).length;

        expect(size('topQuarter')).toBe(25);
        expect(size('middle')).toBe(25);
        expect(size('bottomHalf')).toBe(50);
        expect(size('topOnePercent')).toBe(1);
    });

    it('gives a one-member server a top 1% rather than an empty one', () => {
        /*
         * `Math.ceil` with a floor of 1. A plain `floor(1 * 0.01)` is zero, which would make
         * "top 1%" empty for every guild under a hundred members — most of them — and an
         * empty cohort reads as "no data" rather than "one person".
         */
        const memberships = assignCohorts(ranked(1));

        expect(cohortOf(memberships, 'user-1')).toEqual(['topOnePercent', 'topQuarter']);
        expect(memberships.filter((membership) => membership.cohort === 'bottomHalf')).toHaveLength(0);
    });

    it('ranks by XP, not by input order', () => {
        const memberships = assignCohorts([member('quiet', 10), member('loud', 10_000)]);

        expect(cohortOf(memberships, 'loud')).toContain('topQuarter');
        expect(cohortOf(memberships, 'quiet')).toContain('bottomHalf');
    });

    it('is deterministic when two members are tied', () => {
        // Arbitrary either way, but stable across runs — otherwise the same guild's report
        // reshuffles its boundary members on every recompute.
        const first = assignCohorts([member('b', 100), member('a', 100)]);
        const second = assignCohorts([member('a', 100), member('b', 100)]);

        expect(cohortOf(first, 'a')).toEqual(cohortOf(second, 'a'));
    });

    it('returns nothing for an empty server', () => {
        expect(assignCohorts([])).toEqual([]);
    });
});

describe('median', () => {
    it('takes the middle of an odd-length list', () => {
        expect(median([3, 1, 2])).toBe(2);
    });

    it('averages the two middles of an even-length list, rounded', () => {
        // Rounded because every figure it feeds is displayed as a whole number — days, XP,
        // levels. A median of 1.5 days would render as "1.5 days to level 3", which reads as
        // more precision than a day-bucketed input can carry.
        expect(median([1, 2])).toBe(2);
        expect(median([1, 4])).toBe(3);
    });

    it('does not mutate its input', () => {
        // It sorts, and sorting in place would reorder a caller's array behind its back.
        const values = [3, 1, 2];
        median(values);

        expect(values).toEqual([3, 1, 2]);
    });

    it('is null for nothing, rather than zero', () => {
        // Zero is a real median. "There was nothing to take a median of" is not.
        expect(median([])).toBeNull();
    });
});

describe('COHORT_LABELS', () => {
    it('labels every cohort', () => {
        // The compile-time guard catches a missing member, but only while it is a `keyof`
        // check — this proves the labels exist at runtime too.
        for (const cohort of COHORT_KEYS) {
            expect(COHORT_LABELS[cohort]).toBeTruthy();
        }
    });
});
