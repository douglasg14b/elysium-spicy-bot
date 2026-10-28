import { beforeAll, describe, expect, it } from 'vitest';
import { ACTION_OPEN_TICKET } from '../../blocks/actionOpenTicket';
import { ACTION_POST_EMBED } from '../../blocks/actionPostEmbed';
import { ACTION_SEND_MESSAGE } from '../../blocks/actionSendMessage';
import { ensureBlocksDiscovered } from '../../blocks/registry';
import { TRIGGER_BUTTON_CLICK } from '../../blocks/triggerButtonClick';
import { FLOW_GRAPH_VERSION, type FlowGraph, type FlowNode } from '../../data/flowGraph';
import { blockButtonIssues, blockButtonPicksIn, postedButtonNodesIn } from '../blockButtonReferences';
import { flowReadinessIssues } from '../flowReadiness';
import type { ReadinessScope } from '../readinessScope';

/**
 * The block-button half of readiness: a Button Click naming a button under a block's post must
 * name a node of this flow or of another flow in its journey, that still posts buttons, and
 * still has that key — and only one trigger in a flow may name it.
 */

const CHANNEL = '111111111111111111';

function postEmbed(id: string, title: string, keys: readonly string[]): FlowNode {
    return {
        id,
        type: ACTION_POST_EMBED,
        position: { x: 0, y: 0 },
        data: {
            channelId: CHANNEL,
            message: { embeds: [{ title }] },
            buttons: keys.map((key) => ({ key, label: key, style: 'Primary' })),
        },
    };
}

function press(id: string, button: unknown): FlowNode {
    return {
        id,
        type: TRIGGER_BUTTON_CLICK,
        position: { x: 0, y: 200 },
        data: { button, eligibility: { principal: 'anyone' } },
    };
}

function graphOf(...nodes: FlowNode[]): FlowGraph {
    return { version: FLOW_GRAPH_VERSION, nodes, edges: [] };
}

/** "poster" is the journey's other flow: a Post Embed and a Send Message. */
const POSTER: FlowGraph = graphOf(postEmbed('post', 'Kneel, pet', ['kneel', 'beg']), {
    id: 'plain',
    type: ACTION_SEND_MESSAGE,
    position: { x: 0, y: 0 },
    data: { channelId: CHANNEL, message: 'Hi' },
});

const SCOPE: ReadinessScope = {
    flowId: 'listener',
    declarations: [],
    journeyFlows: [{ flowId: 'poster', name: 'Poster', graph: POSTER }],
};

const pick = (flowId: string, nodeId: string, buttonKey: string) => ({ flowId, nodeId, buttonKey });

beforeAll(async () => {
    await ensureBlocksDiscovered();
});

describe('blockButtonIssues', () => {
    it("passes a pick naming another journey flow's post and one of its buttons", () => {
        expect(blockButtonIssues(graphOf(press('press-1', pick('poster', 'post', 'kneel'))), SCOPE)).toEqual([]);
    });

    it("judges this flow's own post against the graph being judged, not a stored copy", () => {
        // An unsaved canvas: its own Post Embed is only here.
        const graph = graphOf(postEmbed('own-post', 'Mine', ['mine']), press('press-1', pick('listener', 'own-post', 'mine')));

        expect(blockButtonIssues(graph, SCOPE)).toEqual([]);
        expect(blockButtonIssues(graph, { ...SCOPE, journeyFlows: [] })).toEqual([]);
        // A stored copy of this flow without the post, handed in anyway, is not what is judged.
        const stale = { flowId: 'listener', name: 'Listener', graph: graphOf() };
        expect(blockButtonIssues(graph, { ...SCOPE, journeyFlows: [stale, ...SCOPE.journeyFlows] })).toEqual([]);
    });

    it.each([
        [
            'a flow outside the journey',
            pick('stranger', 'post', 'kneel'),
            "That button's flow isn't in this flow's journey any more, or it's gone. Pick another.",
        ],
        ['a posting node that is gone', pick('poster', 'deleted', 'kneel'), 'The block that posts that button is gone. Pick another.'],
        ['a block that posts no buttons', pick('poster', 'plain', 'kneel'), "That block doesn't post buttons. Pick another."],
        ['a button no longer on the post', pick('poster', 'post', 'spank'), '"Kneel, pet" has no button "spank" any more. Pick another.'],
    ])('refuses %s, at the field', (_case, value, message) => {
        expect(blockButtonIssues(graphOf(press('press-1', value)), SCOPE)).toEqual([
            { nodeId: 'press-1', field: 'button', message },
        ]);
    });

    it('marks both of two triggers in one flow on one button, and neither on different buttons', () => {
        const clash = graphOf(press('press-1', pick('poster', 'post', 'kneel')), press('press-2', pick('poster', 'post', 'kneel')));
        expect(blockButtonIssues(clash, SCOPE)).toEqual([
            { nodeId: 'press-1', field: 'button', message: 'Two triggers in this flow listen to "kneel". One press starts one run.' },
            { nodeId: 'press-2', field: 'button', message: 'Two triggers in this flow listen to "kneel". One press starts one run.' },
        ]);

        const apart = graphOf(press('press-1', pick('poster', 'post', 'kneel')), press('press-2', pick('poster', 'post', 'beg')));
        expect(blockButtonIssues(apart, SCOPE)).toEqual([]);
    });

    it("leaves a journey message's pick, and a flow not yet created, to their own rules", () => {
        expect(blockButtonIssues(graphOf(press('press-1', { messageKey: 'rules-panel', buttonKey: 'kneel' })), SCOPE)).toEqual([]);
        // No id yet: nothing can have named it, so a pick naming any flow is outside the journey.
        expect(
            blockButtonIssues(graphOf(press('press-1', pick('poster', 'post', 'kneel'))), {
                flowId: null,
                declarations: [],
                journeyFlows: [],
            })
        ).toHaveLength(1);
    });

    it('is asked by readiness, so the builder, the list and the switch-on gate agree', () => {
        expect(flowReadinessIssues(graphOf(press('press-1', pick('poster', 'post', 'spank'))), SCOPE)).toEqual([
            { nodeId: 'press-1', field: 'button', message: '"Kneel, pet" has no button "spank" any more. Pick another.' },
        ]);
    });
});

describe('blockButtonPicksIn and postedButtonNodesIn', () => {
    it('reads only block picks, and only the nodes whose message field names a buttonsKey', () => {
        const graph = graphOf(
            press('press-1', pick('poster', 'post', 'kneel')),
            press('press-2', { messageKey: 'rules-panel', buttonKey: 'kneel' }),
            postEmbed('post', 'Kneel, pet', ['kneel']),
            {
                id: 'ticket',
                type: ACTION_OPEN_TICKET,
                position: { x: 0, y: 0 },
                data: { ticketType: 'support', buttons: [{ key: 'close', label: 'Close', style: 'Danger' }] },
            },
            ...POSTER.nodes.filter((node) => node.id === 'plain')
        );

        expect(blockButtonPicksIn(graph)).toEqual([
            { nodeId: 'press-1', fieldKey: 'button', pick: pick('poster', 'post', 'kneel') },
        ]);
        expect(postedButtonNodesIn(graph)).toEqual([
            {
                nodeId: 'post',
                blockLabel: 'Post Embed',
                headline: 'Kneel, pet',
                buttons: [{ key: 'kneel', label: 'kneel', style: 'Primary' }],
            },
            // No message yet: the block's label stands in for its headline.
            {
                nodeId: 'ticket',
                blockLabel: 'Open Ticket',
                headline: null,
                buttons: [{ key: 'close', label: 'Close', style: 'Danger' }],
            },
        ]);
    });
});
