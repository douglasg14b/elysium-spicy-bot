import { describe, expect, it } from 'vitest';
import type { DriftedResource, JourneyDrift, OrphanedResource, RepairedResource } from '../../api/types';
import {
    driftHeadline,
    hasFindings,
    hasRepairable,
    repairableKeys,
    repairLabel,
    riskyOrphans,
    summariseForget,
    summariseRepair,
    whyNotRepairable,
} from '../driftSummary';

/**
 * The copy and the judgement behind the drift dialog.
 *
 * All of it lives here rather than in the component because `web/` runs without jsdom
 * — a decision left in JSX is one no test can reach. These are the cases where the
 * wording is load-bearing: the denominator in the headline, the two different reasons
 * a resource is not repairable, and the partial-repair report.
 */

function drifted(overrides: Partial<DriftedResource> = {}): DriftedResource {
    return {
        resourceKey: 'qa-channel',
        name: 'questions',
        kind: 'textChannel',
        drift: [{ kind: 'renamed', explanation: 'Renamed from **questions** to **general**.' }],
        repairable: true,
        ...overrides,
    };
}

function orphan(overrides: Partial<OrphanedResource> = {}): OrphanedResource {
    return {
        bindingId: 42,
        resourceKey: 'old-channel',
        kind: 'textChannel',
        name: 'archive',
        stillInGuild: true,
        neverSettled: false,
        explanation: '**archive** is no longer declared by this journey.',
        ...overrides,
    };
}

function report(overrides: Partial<JourneyDrift> = {}): JourneyDrift {
    return {
        journeyKey: 'onboarding',
        drifted: [],
        cleanKeys: [],
        unchecked: [],
        orphans: [],
        ...overrides,
    };
}

describe('driftHeadline', () => {
    it('states the denominator rather than a bare count of problems', () => {
        const line = driftHeadline(
            report({ drifted: [drifted()], cleanKeys: ['a', 'b', 'c', 'd', 'e', 'f'] })
        );

        // "1 drifted" makes an operator wonder what else was looked at.
        expect(line).toContain('1 of 7');
    });

    it('counts unchecked resources in the denominator', () => {
        const line = driftHeadline(
            report({
                drifted: [drifted()],
                cleanKeys: ['a'],
                unchecked: [{ resourceKey: 'dm', name: 'private', reason: 'Names a subject.' }],
            })
        );

        expect(line).toContain('1 of 3');
    });

    it('says everything matches when nothing drifted', () => {
        const line = driftHeadline(report({ cleanKeys: ['a', 'b'] }));

        expect(line).toContain('All 2');
        expect(line).toContain('exactly as declared');
    });

    it('reads naturally for a single clean resource', () => {
        expect(driftHeadline(report({ cleanKeys: ['a'] }))).toContain('The one thing');
    });

    it('does not claim a clean bill of health before anything is installed', () => {
        // The empty case must not read as "all 0 are fine", which sounds like a pass.
        expect(driftHeadline(report())).toBe('Nothing installed to check yet.');
    });
});

describe('hasFindings', () => {
    it('counts an unchecked resource as something to look at', () => {
        // Reporting the journey healthy while a staff-only channel sits unexamined is
        // the false-clean the feature exists to prevent.
        expect(
            hasFindings(
                report({
                    cleanKeys: ['a'],
                    unchecked: [{ resourceKey: 'dm', name: 'private', reason: 'Subject.' }],
                })
            )
        ).toBe(true);
    });

    it('counts an orphan even when nothing drifted', () => {
        expect(hasFindings(report({ orphans: [orphan()] }))).toBe(true);
    });

    it('is false for a genuinely clean journey', () => {
        expect(hasFindings(report({ cleanKeys: ['a', 'b'] }))).toBe(false);
    });
});

describe('repairableKeys', () => {
    it('selects everything repairable and nothing else', () => {
        const keys = repairableKeys(
            report({
                drifted: [
                    drifted({ resourceKey: 'a' }),
                    drifted({ resourceKey: 'b', repairable: false }),
                    drifted({ resourceKey: 'c' }),
                ],
            })
        );

        expect(keys).toEqual(['a', 'c']);
    });
});

describe('hasRepairable', () => {
    it('is false when every finding is withheld, so no button is offered', () => {
        expect(
            hasRepairable(report({ drifted: [drifted({ repairable: false })] }))
        ).toBe(false);
    });

    it('is true when at least one can be put back', () => {
        expect(
            hasRepairable(
                report({ drifted: [drifted({ repairable: false }), drifted({ resourceKey: 'b' })] })
            )
        ).toBe(true);
    });
});

describe('whyNotRepairable', () => {
    it('says nothing for a repairable resource', () => {
        expect(whyNotRepairable(drifted())).toBeNull();
    });

    it('distinguishes a wrong type from an adoption', () => {
        const wrongType = whyNotRepairable(
            drifted({
                repairable: false,
                drift: [{ kind: 'wrongType', explanation: 'Points at a category now.' }],
            })
        );
        const adopted = whyNotRepairable(drifted({ repairable: false }));

        // One is a job to do and the other is a promise being kept. Collapsing them
        // into "cannot be repaired" would hide which.
        expect(wrongType).toContain('decide');
        expect(adopted).toContain('adopted');
        expect(wrongType).not.toEqual(adopted);
    });
});

describe('repairLabel', () => {
    it('names how many it will touch', () => {
        expect(repairLabel(1)).toBe('Repair 1 resource');
        expect(repairLabel(3)).toBe('Repair 3 resources');
    });
});

describe('summariseRepair', () => {
    function result(overrides: Partial<RepairedResource> = {}): RepairedResource {
        return {
            resourceKey: 'qa',
            kind: 'textChannel',
            name: 'questions',
            outcome: 'repaired',
            ...overrides,
        };
    }

    it('reports a clean run plainly', () => {
        const summary = summariseRepair([result(), result({ resourceKey: 'b' })]);

        expect(summary.color).toBe('brand');
        expect(summary.message).toContain('2 resources');
    });

    it('names the first reason rather than counting failures', () => {
        const summary = summariseRepair([
            result(),
            result({ resourceKey: 'b', outcome: 'failed', explanation: 'Missing permissions.' }),
        ]);

        expect(summary.color).toBe('orange');
        expect(summary.message).toContain('Missing permissions.');
    });

    /*
     * The shape below is what the engine actually sends, and getting it wrong is how
     * this function shipped broken.
     *
     * `applyDriftRepair` catches `PartialRepairError` and emits `outcome: 'failed'`
     * with a populated `repaired` array — there is no `partiallyRepaired` outcome;
     * `REPAIR_OUTCOMES` has three members. The first version of this test invented a
     * fourth, asserted against it, and passed, while the real partial path fell through
     * to the plain-failure branch. A fixture that manufactures a value the server
     * cannot produce certifies nothing.
     *
     * So partiality is read off the field that genuinely carries it.
     */
    it('counts a partial repair as done rather than failed', () => {
        // A rename landed before a later permission fix threw. Telling the operator it
        // "failed" would be wrong about a channel that really was renamed.
        const summary = summariseRepair([
            result({ outcome: 'failed', repaired: ['renamed'], explanation: 'Discord refused.' }),
        ]);

        expect(summary.title).toBe('Partly repaired');
        expect(summary.message).toContain('1 repaired');
    });

    it('treats a failure that landed nothing as a plain failure', () => {
        // The discriminator is `repaired`, so a bare failure must not be dressed up as
        // partial success.
        const summary = summariseRepair([
            result({ outcome: 'failed', explanation: 'Missing permissions.' }),
        ]);

        expect(summary.title).not.toBe('Partly repaired');
        expect(summary.message).toContain('0 repaired');
    });

    it('treats an empty result as nothing to do, not as a failure', () => {
        // The rebuild found the drift already resolved — which is what happens when an
        // operator fixes it by hand while reading the report.
        const summary = summariseRepair([]);

        expect(summary.title).toBe('Nothing to do');
        expect(summary.color).not.toBe('red');
    });
});

describe('summariseForget', () => {
    it('warns when the object is left behind untracked', () => {
        const summary = summariseForget({ name: 'archive', objectRemains: true });

        expect(summary.message).toContain('still in your server');
        expect(summary.message).toContain('nothing will manage it');
    });

    it('says plainly when nothing was left behind', () => {
        const summary = summariseForget({ name: 'archive', objectRemains: false });

        expect(summary.message).toContain('Nothing was left behind');
    });
});

describe('riskyOrphans', () => {
    it('picks out a never-settled record with a live object behind it', () => {
        // The crash-between-create-and-settle case: forgetting this one genuinely
        // loses the only pointer to a real channel.
        const risky = riskyOrphans([
            orphan({ bindingId: 1 }),
            orphan({ bindingId: 2, neverSettled: true, stillInGuild: true }),
            orphan({ bindingId: 3, neverSettled: true, stillInGuild: false }),
        ]);

        expect(risky.map((entry) => entry.bindingId)).toEqual([2]);
    });
});
