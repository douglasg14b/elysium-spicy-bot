import { describe, expect, it } from 'vitest';
import type { FlowJourneyMembership, FlowSummary } from '../../api/types';
import {
    buildFlowsListRows,
    decideDropOutcome,
    describeDropOutcome,
    dropNeedsConfirmation,
} from '../flowGrouping';

/**
 * The grouping rules, pinned where they can fail.
 *
 * The one worth the most attention is the single-flow journey: nearly every flow that
 * declares a resource has one, so a bug that renders it as a group does not affect an
 * edge case — it changes the page for almost everybody, and surfaces a concept the PRD
 * says must stay invisible until an operator asks for it.
 */

function flow(
    flowId: string,
    name: string,
    journey: FlowJourneyMembership | null = null
): FlowSummary {
    return {
        flowId,
        name,
        enabled: true,
        nodeCount: 3,
        journey,
        createdAt: '2026-09-01T00:00:00.000Z',
        updatedAt: '2026-09-01T00:00:00.000Z',
    };
}

function journey(
    journeyKey: string,
    name: string,
    memberCount: number,
    resourceCount = 2
): FlowJourneyMembership {
    // Fully installed by default, which is the state that shows no chip — so a test about
    // grouping is never accidentally also a test about the install chip.
    return {
        journeyKey,
        name,
        resourceCount,
        memberCount,
        installState: 'all',
        installedCount: resourceCount,
        installedKeys: Array.from({ length: resourceCount }, (_unused, index) => `key-${index}`),
    };
}

describe('buildFlowsListRows', () => {
    it('renders a flow with no journey as a plain row', () => {
        const rows = buildFlowsListRows([flow('f1', 'Rules gate')]);

        expect(rows).toEqual([{ kind: 'flow', flow: flow('f1', 'Rules gate') }]);
    });

    /** The case that keeps Case A free of the concept. */
    it('renders a flow whose journey holds only itself as a plain row', () => {
        const rows = buildFlowsListRows([
            flow('f1', 'Rules gate', journey('rules-gate', 'Rules gate', 1)),
        ]);

        expect(rows).toHaveLength(1);
        expect(rows[0]?.kind).toBe('flow');
    });

    it('groups two flows that share a journey', () => {
        const shared = journey('onboarding', 'Onboarding', 2, 4);
        const rows = buildFlowsListRows([
            flow('f1', 'Welcome', shared),
            flow('f2', 'Rules gate', shared),
        ]);

        expect(rows).toHaveLength(1);
        const group = rows[0];
        expect(group).toMatchObject({
            kind: 'group',
            journeyKey: 'onboarding',
            name: 'Onboarding',
            resourceCount: 4,
        });
        expect(group.kind === 'group' && group.flows.map((member) => member.flowId)).toEqual([
            'f1',
            'f2',
        ]);
    });

    it('keeps ungrouped flows beside a group, in their original order', () => {
        const shared = journey('onboarding', 'Onboarding', 2);
        const rows = buildFlowsListRows([
            flow('f1', 'Welcome', shared),
            flow('f2', 'Birthday'),
            flow('f3', 'Rules gate', shared),
            flow('f4', 'Tickets'),
        ]);

        expect(rows.map((row) => (row.kind === 'group' ? row.journeyKey : row.flow.flowId))).toEqual([
            'onboarding',
            'f2',
            'f4',
        ]);
    });

    /**
     * A group sits where its first member was, rather than being hoisted. Hoisting would
     * move rows the operator was not touching the moment they joined two others.
     */
    it('anchors a group at its earliest member rather than sorting groups to the top', () => {
        const shared = journey('onboarding', 'Onboarding', 2);
        const rows = buildFlowsListRows([
            flow('f1', 'Birthday'),
            flow('f2', 'Welcome', shared),
            flow('f3', 'Rules gate', shared),
        ]);

        expect(rows[0]).toMatchObject({ kind: 'flow' });
        expect(rows[1]).toMatchObject({ kind: 'group', journeyKey: 'onboarding' });
    });

    it('keeps two separate journeys as two separate groups', () => {
        const onboarding = journey('onboarding', 'Onboarding', 2);
        const tickets = journey('tickets', 'Tickets', 2);
        const rows = buildFlowsListRows([
            flow('f1', 'Welcome', onboarding),
            flow('f2', 'Ticket open', tickets),
            flow('f3', 'Rules gate', onboarding),
            flow('f4', 'Ticket close', tickets),
        ]);

        expect(rows).toHaveLength(2);
        expect(rows.map((row) => row.kind === 'group' && row.journeyKey)).toEqual([
            'onboarding',
            'tickets',
        ]);
    });

    it('handles an empty list', () => {
        expect(buildFlowsListRows([])).toEqual([]);
    });
});

describe('decideDropOutcome', () => {
    it('creates a group from two ungrouped flows', () => {
        const outcome = decideDropOutcome(flow('f1', 'Rules'), flow('f2', 'Welcome'));

        expect(outcome).toEqual({ kind: 'createGroup', targetFlowId: 'f2' });
    });

    it('joins an existing group when the target is already grouped', () => {
        const shared = journey('onboarding', 'Onboarding', 2);
        const outcome = decideDropOutcome(flow('f1', 'Tickets'), flow('f2', 'Welcome', shared));

        expect(outcome).toEqual({
            kind: 'joinGroup',
            targetFlowId: 'f2',
            journeyName: 'Onboarding',
        });
    });

    it('refuses a drop onto itself', () => {
        const same = flow('f1', 'Rules');

        expect(decideDropOutcome(same, same).kind).toBe('none');
    });

    it('refuses a drop onto a flow already sharing the journey', () => {
        const shared = journey('onboarding', 'Onboarding', 2);
        const outcome = decideDropOutcome(
            flow('f1', 'Welcome', shared),
            flow('f2', 'Rules gate', shared)
        );

        expect(outcome).toEqual({ kind: 'none', reason: 'Already in Onboarding.' });
    });

    /**
     * A lone flow's implicit journey must not be mistaken for a group to join — the
     * target is ungrouped as far as the operator is concerned, so this is a create.
     */
    it('creates rather than joins when the target journey holds only the target', () => {
        const outcome = decideDropOutcome(
            flow('f1', 'Tickets'),
            flow('f2', 'Welcome', journey('welcome', 'Welcome', 1))
        );

        expect(outcome).toEqual({ kind: 'createGroup', targetFlowId: 'f2' });
    });

    it('leaves the group when dropped outside one', () => {
        const outcome = decideDropOutcome(
            flow('f1', 'Welcome', journey('onboarding', 'Onboarding', 2)),
            null
        );

        expect(outcome).toEqual({ kind: 'leaveGroup', journeyName: 'Onboarding' });
    });

    it('does nothing when an ungrouped flow is dropped outside a group', () => {
        expect(decideDropOutcome(flow('f1', 'Rules'), null).kind).toBe('none');
    });

    it('does nothing when a flow with a lone journey is dropped outside a group', () => {
        const outcome = decideDropOutcome(
            flow('f1', 'Rules', journey('rules', 'Rules', 1)),
            null
        );

        expect(outcome.kind).toBe('none');
    });
});

describe('describeDropOutcome', () => {
    it('says nothing for a drop that would do nothing', () => {
        expect(describeDropOutcome({ kind: 'none', reason: 'Same flow.' })).toBeNull();
    });

    it('names the journey being joined', () => {
        expect(
            describeDropOutcome({
                kind: 'joinGroup',
                targetFlowId: 'f2',
                journeyName: 'Onboarding',
            })
        ).toBe('Add to Onboarding');
    });

    it('names the journey being left', () => {
        expect(describeDropOutcome({ kind: 'leaveGroup', journeyName: 'Onboarding' })).toBe(
            'Leave Onboarding'
        );
    });
});

describe('dropNeedsConfirmation', () => {
    it('lets a flow with no resources group silently', () => {
        expect(dropNeedsConfirmation({ kind: 'createGroup', targetFlowId: 'f2' }, 0)).toBe(false);
    });

    it('stops to ask when the moving flow declares resources', () => {
        expect(dropNeedsConfirmation({ kind: 'createGroup', targetFlowId: 'f2' }, 3)).toBe(true);
    });

    /** Leaving always asks: pending nodes start failing to save either way. */
    it('always confirms leaving a group, even with no resources of its own', () => {
        expect(dropNeedsConfirmation({ kind: 'leaveGroup', journeyName: 'Onboarding' }, 0)).toBe(
            true
        );
    });

    it('never confirms a drop that would do nothing', () => {
        expect(dropNeedsConfirmation({ kind: 'none', reason: 'Same flow.' }, 5)).toBe(false);
    });
});
