import { describe, expect, it } from 'vitest';
import type { ResourceBindingEntity } from '../../data/resourceBindingsSchema';
import { groupBindingsByJourney, summariseJourneyInstall } from '../journeyInstallState';

function binding(overrides: Partial<ResourceBindingEntity> = {}): ResourceBindingEntity {
    return {
        id: 1,
        guildId: 'guild-1',
        journeyKey: 'onboarding',
        resourceKey: 'welcome',
        kind: 'textChannel',
        state: 'created',
        discordId: '100',
        name: 'welcome',
        createdAt: new Date('2026-09-23T10:00:00.000Z'),
        updatedAt: new Date('2026-09-23T10:00:00.000Z'),
        ...overrides,
    };
}

describe('summariseJourneyInstall', () => {
    it('reports a journey whose every declaration is bound as fully installed', () => {
        expect(
            summariseJourneyInstall({
                declaredKeys: ['welcome', 'rules'],
                bindings: [binding(), binding({ id: 2, resourceKey: 'rules', discordId: '101' })],
            })
        ).toEqual({
            state: 'all',
            installedCount: 2,
            declaredCount: 2,
            installedKeys: ['welcome', 'rules'],
        });
    });

    it('reports a partly installed journey rather than rounding it', () => {
        // The state a half-finished install leaves, and the state adding a resource to an
        // already-installed journey creates. Rounding it either way misleads: down offers
        // to create things that exist, up hides a flow pointing at a missing channel.
        expect(
            summariseJourneyInstall({
                declaredKeys: ['welcome', 'rules', 'verified'],
                bindings: [binding()],
            })
        ).toEqual({
            state: 'partial',
            installedCount: 1,
            declaredCount: 3,
            // Named, not just counted: the declarations editor freezes exactly these keys.
            installedKeys: ['welcome'],
        });
    });

    it('does not count an `intended` binding as installed', () => {
        // The crash-safety row, written before the guild is touched. Counting it would
        // report an install that *failed* as having succeeded — on the chip whose only
        // job is telling the operator whether to press install.
        expect(
            summariseJourneyInstall({
                declaredKeys: ['welcome'],
                bindings: [binding({ state: 'intended', discordId: null })],
            })
        ).toEqual({ state: 'none', installedCount: 0, declaredCount: 1, installedKeys: [] });
    });

    it('does not count a live state that never got an id', () => {
        // A `created` row with no `discordId` names nothing an operator could look at, and
        // nothing a teardown could delete. Both halves of `isLive` are load-bearing.
        expect(
            summariseJourneyInstall({
                declaredKeys: ['welcome'],
                bindings: [binding({ state: 'created', discordId: null })],
            })
        ).toEqual({ state: 'none', installedCount: 0, declaredCount: 1, installedKeys: [] });
    });

    it('counts an adopted resource as installed', () => {
        // Adopted and created are both live; they differ only in provenance, which matters
        // for teardown and not at all for "is it there?".
        expect(
            summariseJourneyInstall({
                declaredKeys: ['welcome'],
                bindings: [binding({ state: 'adopted' })],
            }).state
        ).toBe('all');
    });

    it('ignores a binding naming a key the journey no longer declares', () => {
        // Ordinary: a resource deleted from the panel keeps its binding until a teardown
        // removes the channel. Counted, it would let `installedCount` exceed
        // `declaredCount` and report `all` for a journey none of whose resources exist.
        expect(
            summariseJourneyInstall({
                declaredKeys: ['rules'],
                bindings: [binding({ resourceKey: 'deleted-last-week' })],
            })
        ).toEqual({ state: 'none', installedCount: 0, declaredCount: 1, installedKeys: [] });
    });

    it('names installed keys in declaration order, not binding order', () => {
        // The list drives a per-row freeze in the declarations editor, so it has to be a
        // subset of what the journey declares rather than a projection of the binding
        // table. Deriving it from `declaredKeys` is what guarantees that — a binding for a
        // resource that was deleted cannot freeze a key nothing declares.
        const summary = summariseJourneyInstall({
            declaredKeys: ['welcome', 'rules', 'verified'],
            bindings: [
                binding({ id: 1, resourceKey: 'verified', discordId: '902' }),
                binding({ id: 2, resourceKey: 'gone-since', discordId: '903' }),
                binding({ id: 3, resourceKey: 'welcome' }),
            ],
        });

        expect(summary.installedKeys).toEqual(['welcome', 'verified']);
        expect(summary.installedCount).toBe(2);
    });

    it('calls a journey declaring nothing `none`, not vacuously installed', () => {
        // The caller suppresses the chip on a zero count, which it can only do if this
        // does not claim success for a journey with nothing in it.
        expect(summariseJourneyInstall({ declaredKeys: [], bindings: [] })).toEqual({
            state: 'none',
            installedCount: 0,
            declaredCount: 0,
            installedKeys: [],
        });
    });
});

describe('groupBindingsByJourney', () => {
    it('keeps each journey\'s bindings apart', () => {
        // A resource key is only unique *within* a journey, so two journeys can both
        // declare `welcome` and mean different channels. Flattening them would report one
        // journey as installed on the strength of the other's binding.
        const grouped = groupBindingsByJourney([
            binding({ id: 1, journeyKey: 'onboarding', resourceKey: 'welcome' }),
            binding({ id: 2, journeyKey: 'tickets', resourceKey: 'welcome' }),
            binding({ id: 3, journeyKey: 'onboarding', resourceKey: 'rules' }),
        ]);

        expect(grouped.get('onboarding')?.map((row) => row.resourceKey)).toEqual([
            'welcome',
            'rules',
        ]);
        expect(grouped.get('tickets')?.map((row) => row.resourceKey)).toEqual(['welcome']);
    });

    it('has no entry for a journey with no bindings', () => {
        expect(groupBindingsByJourney([]).get('onboarding')).toBeUndefined();
    });
});
