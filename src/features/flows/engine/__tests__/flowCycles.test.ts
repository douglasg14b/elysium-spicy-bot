import { beforeAll, describe, expect, it } from 'vitest';
import { ensureBlocksDiscovered } from '../../blocks/registry';
import { FLOW_GRAPH_VERSION, type FlowEdge, type FlowNode } from '../../data/flowGraph';
import { describeFlowCycle, findFlowCycleThrough, type FlowCycleCandidate } from '../flowCycles';

/**
 * The cycle finder, against the real blocks through the registry — so what links two
 * triggers is what each block's manifest declares it emits, read exactly as a save reads it.
 *
 * Fixtures reuse node ids across flows on purpose (`trigger-1`, `action-1`): the builder's
 * ids are unique only by timing, so a finder keyed by node id alone would merge two flows'
 * triggers into one.
 */

function node(id: string, type: string, data: Record<string, unknown> = {}): FlowNode {
    return { id, type, position: { x: 0, y: 0 }, data };
}

function edge(source: string, target: string): FlowEdge {
    return { id: `${source}-${target}`, source, target };
}

function flow(flowId: string, name: string, nodes: FlowNode[], edges: FlowEdge[]): FlowCycleCandidate {
    return { flowId, name, graph: { version: FLOW_GRAPH_VERSION, nodes, edges } };
}

/** One trigger wired to one action: the shape almost every fixture here takes. */
function twoStep(flowId: string, name: string, trigger: FlowNode, action: FlowNode): FlowCycleCandidate {
    return flow(flowId, name, [trigger, action], [edge(trigger.id, action.id)]);
}

const ticketEvent = (id: string, data: Record<string, unknown>): FlowNode => node(id, 'trigger.ticketEvent', data);
const openTicket = (id: string, ticketType: string): FlowNode =>
    node(id, 'action.openTicket', { ticketType, title: 'Round and round' });
const closeTicket = (id: string): FlowNode => node(id, 'action.closeTicket', { ticketId: '{{var.ticketId}}' });
const memberLeaves = (id: string): FlowNode => node(id, 'trigger.memberLeave');
const kickMember = (id: string): FlowNode => node(id, 'action.kickMember');

beforeAll(async () => {
    await ensureBlocksDiscovered();
});

describe('a cycle between flows', () => {
    it('is found from the saved flow, with its steps in order and back again', () => {
        const opener = twoStep('flow-a', 'Reopener', ticketEvent('trigger-1', { event: 'closed' }), openTicket('action-1', 'support'));
        const closer = twoStep(
            'flow-b',
            'Closer',
            ticketEvent('trigger-1', { event: 'opened', ticketType: 'support' }),
            closeTicket('action-1')
        );

        expect(findFlowCycleThrough([closer, opener], 'flow-a')).toEqual([
            { flowId: 'flow-a', flowName: 'Reopener', emitterNodeId: 'action-1', emitterLabel: 'Open Ticket' },
            { flowId: 'flow-b', flowName: 'Closer', emitterNodeId: 'action-1', emitterLabel: 'Close Ticket' },
        ]);
        // The same cycle, read from the other end, starts there.
        expect(findFlowCycleThrough([closer, opener], 'flow-b')?.map((step) => step.flowId)).toEqual([
            'flow-b',
            'flow-a',
        ]);
    });

    it('is not one when a cycle runs among other flows only', () => {
        const opener = twoStep('flow-a', 'Reopener', ticketEvent('trigger-1', { event: 'closed' }), openTicket('action-1', 'support'));
        const closer = twoStep(
            'flow-b',
            'Closer',
            ticketEvent('trigger-1', { event: 'opened', ticketType: 'support' }),
            closeTicket('action-1')
        );
        const bystander = twoStep('flow-c', 'Bystander', memberLeaves('trigger-1'), closeTicket('action-1'));

        expect(findFlowCycleThrough([opener, closer, bystander], 'flow-c')).toBeNull();
    });
});

describe('what an emission carries', () => {
    it('narrows by ticket type: Open Ticket (Support) does not start Ticket Opened (Verification)', () => {
        const verifier = twoStep(
            'flow-a',
            'Verifier',
            ticketEvent('trigger-1', { event: 'opened', ticketType: 'verification' }),
            openTicket('action-1', 'support')
        );

        expect(findFlowCycleThrough([verifier], 'flow-a')).toBeNull();
    });

    it('lets a Ticket Opened with no type filter be started by any opened ticket', () => {
        const anyOpened = twoStep('flow-a', 'Anything', ticketEvent('trigger-1', { event: 'opened' }), openTicket('action-1', 'support'));

        expect(findFlowCycleThrough([anyOpened], 'flow-a')).toHaveLength(1);
    });

    it('lets Close Ticket start Ticket Closed whatever its type filter, since the ticket is unknown', () => {
        const typed = twoStep(
            'flow-a',
            'Typed',
            ticketEvent('trigger-1', { event: 'closed', ticketType: 'verification' }),
            closeTicket('action-1')
        );

        expect(findFlowCycleThrough([typed], 'flow-a')).toHaveLength(1);
    });

    it('does not let Close Ticket start a listener for another event', () => {
        const claimed = twoStep('flow-a', 'Claimed', ticketEvent('trigger-1', { event: 'claimed' }), closeTicket('action-1'));

        expect(findFlowCycleThrough([claimed], 'flow-a')).toBeNull();
    });

    it('lets Kick Member start Member Leaves — the accepted over-refusal, since the kicked member is gone', () => {
        const bouncer = twoStep('flow-a', 'Bouncer', memberLeaves('trigger-1'), kickMember('action-1'));

        expect(findFlowCycleThrough([bouncer], 'flow-a')).toEqual([
            { flowId: 'flow-a', flowName: 'Bouncer', emitterNodeId: 'action-1', emitterLabel: 'Kick Member' },
        ]);
    });

    it('refuses a flow that starts itself', () => {
        const opener = twoStep(
            'flow-a',
            'Opener',
            ticketEvent('trigger-1', { event: 'opened', ticketType: 'support' }),
            openTicket('action-1', 'support')
        );

        expect(findFlowCycleThrough([opener], 'flow-a')).toEqual([
            { flowId: 'flow-a', flowName: 'Opener', emitterNodeId: 'action-1', emitterLabel: 'Open Ticket' },
        ]);
    });
});

describe('the graph is made of triggers, not whole flows', () => {
    it('does not link two triggers of one flow whose paths never meet', () => {
        const split = flow(
            'flow-a',
            'Split',
            [
                node('join', 'trigger.memberJoin'),
                closeTicket('close'),
                ticketEvent('closed', { event: 'closed' }),
                node('post', 'action.sendMessage', { channelId: 'channel-1', message: 'Closed. Good riddance.' }),
            ],
            [edge('join', 'close'), edge('closed', 'post')]
        );

        expect(findFlowCycleThrough([split], 'flow-a')).toBeNull();
    });

    it('adds no link for an emitting node the trigger cannot reach', () => {
        const stray = flow(
            'flow-a',
            'Stray',
            [ticketEvent('trigger-1', { event: 'closed' }), closeTicket('action-1')],
            []
        );

        expect(findFlowCycleThrough([stray], 'flow-a')).toBeNull();
    });

    it('never puts a Schedule-rooted flow on a cycle, even when it closes tickets', () => {
        const sweeper = twoStep(
            'flow-a',
            'Sweeper',
            node('trigger-1', 'trigger.schedule', { repeat: 'daily', time: '09:00' }),
            closeTicket('action-1')
        );
        const reopener = twoStep('flow-b', 'Reopener', ticketEvent('trigger-1', { event: 'closed' }), openTicket('action-1', 'support'));

        expect(findFlowCycleThrough([sweeper, reopener], 'flow-a')).toBeNull();
    });
});

describe('mirroring what runs', () => {
    it('lets a listening trigger whose config does not parse match nothing', () => {
        // A type filter that is not a string fails Ticket Event's schema, and its dispatcher
        // then starts nothing from it.
        const broken = twoStep('flow-a', 'Broken', ticketEvent('trigger-1', { event: 'closed', ticketType: 42 }), closeTicket('action-1'));

        expect(findFlowCycleThrough([broken], 'flow-a')).toBeNull();
    });

    it('lets an emitting node whose config does not parse cause nothing, since its run fails there', () => {
        const titleless = twoStep(
            'flow-a',
            'Titleless',
            ticketEvent('trigger-1', { event: 'opened' }),
            node('action-1', 'action.openTicket', { ticketType: 'support' })
        );

        expect(findFlowCycleThrough([titleless], 'flow-a')).toBeNull();
    });

    it('skips a node whose block is not registered rather than throwing', () => {
        // A retired trigger starts nothing and is started by nothing, so a flow rooted in
        // one sits on no cycle — and asking about it does not throw.
        const stale = flow(
            'flow-a',
            'Stale',
            [node('trigger-1', 'trigger.retired'), kickMember('action-1')],
            [edge('trigger-1', 'action-1')]
        );
        expect(findFlowCycleThrough([stale], 'flow-a')).toBeNull();

        // A retired action is walked through, not stopped at: the run would fail there,
        // but treating what lies past it as reachable over-refuses, the safe way round.
        const passing = flow(
            'flow-b',
            'Passing',
            [memberLeaves('trigger-1'), node('retired', 'action.retired'), kickMember('action-1')],
            [edge('trigger-1', 'retired'), edge('retired', 'action-1')]
        );
        expect(findFlowCycleThrough([passing], 'flow-b')).toEqual([
            { flowId: 'flow-b', flowName: 'Passing', emitterNodeId: 'action-1', emitterLabel: 'Kick Member' },
        ]);
    });
});

describe('what the finder is handed', () => {
    it('refuses the same flow twice — the saved one belongs in once, without its stored row', () => {
        const bouncer = twoStep('flow-a', 'Bouncer', memberLeaves('trigger-1'), kickMember('action-1'));

        expect(() => findFlowCycleThrough([bouncer, bouncer], 'flow-a')).toThrow(/handed flow flow-a twice/);
    });

    it('refuses a question about a flow it was not handed', () => {
        expect(() => findFlowCycleThrough([], 'flow-a')).toThrow(/not handed/);
    });
});

describe('describeFlowCycle', () => {
    it('names every step of a cycle between flows, back to the first', () => {
        expect(
            describeFlowCycle([
                { flowId: 'flow-a', flowName: 'Welcome', emitterNodeId: 'kick', emitterLabel: 'Kick Member' },
                { flowId: 'flow-b', flowName: 'Goodbye', emitterNodeId: 'close', emitterLabel: 'Close Ticket' },
                { flowId: 'flow-c', flowName: 'Ticket closed', emitterNodeId: 'open', emitterLabel: 'Open Ticket' },
            ])
        ).toBe(
            'That would make a loop between flows: "Welcome" (Kick Member) starts "Goodbye" → "Goodbye" ' +
                '(Close Ticket) starts "Ticket closed" → "Ticket closed" (Open Ticket) starts "Welcome" again. ' +
                'Change one of them, or switch one off.'
        );
    });

    it('words a flow starting itself as that', () => {
        expect(
            describeFlowCycle([
                { flowId: 'flow-a', flowName: 'Opener', emitterNodeId: 'open', emitterLabel: 'Open Ticket' },
            ])
        ).toBe(
            'That would make this flow set itself off in a loop: "Opener" (Open Ticket) starts "Opener" again. ' +
                "Change it so it doesn't."
        );
    });
});
