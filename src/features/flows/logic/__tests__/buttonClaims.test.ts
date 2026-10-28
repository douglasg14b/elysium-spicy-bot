import { beforeAll, describe, expect, it } from 'vitest';
import type { ResourceDeclaration } from '../../../provisioning/logic/resourceDeclaration';
import { ACTION_POST_EMBED } from '../../blocks/actionPostEmbed';
import { ensureBlocksDiscovered } from '../../blocks/registry';
import { TRIGGER_BUTTON_CLICK } from '../../blocks/triggerButtonClick';
import { FLOW_GRAPH_VERSION, type FlowGraph } from '../../data/flowGraph';
import { buttonClaimConflict, buttonClaimRefusal, type ClaimingFlow } from '../buttonClaims';

/**
 * One flow per button: a flow may not listen to a button another live flow of its own
 * journey already listens to. Another journey's same keys are another message's button, and
 * a switched-off flow holds nothing.
 */

const DECLARATIONS: readonly ResourceDeclaration[] = [
    { key: 'rules', kind: 'textChannel', defaultName: 'rules' },
    {
        key: 'rules-panel',
        kind: 'message',
        defaultName: 'Rules panel',
        parentKey: 'rules',
        message: { embeds: [{ title: 'House Rules' }] },
        buttons: [
            { key: 'verify', label: 'Verify', style: 'Success' },
            { key: 'nope', label: 'Nope', style: 'Danger' },
            { key: 'spicy', style: 'Danger', emoji: { name: '🌶️' } },
        ],
    },
];

function pressing(buttonKey: string): FlowGraph {
    return {
        version: FLOW_GRAPH_VERSION,
        nodes: [
            {
                id: 'press',
                type: TRIGGER_BUTTON_CLICK,
                position: { x: 0, y: 0 },
                data: { button: { messageKey: 'rules-panel', buttonKey }, eligibility: { principal: 'anyone' } },
            },
        ],
        edges: [],
    };
}

function flow(flowId: string, name: string, enabled: boolean, graph: FlowGraph): ClaimingFlow {
    return { flowId, name, enabled, graph };
}

beforeAll(async () => {
    await ensureBlocksDiscovered();
});

describe('buttonClaimConflict', () => {
    it('names a live flow of the same journey already on the button', () => {
        const conflict = buttonClaimConflict({
            flowId: 'gatekeeper',
            graph: pressing('verify'),
            flows: [flow('welcome', 'Welcome', true, pressing('verify'))],
            journeyFlowIds: new Set(['gatekeeper', 'welcome']),
            declarations: DECLARATIONS,
            posters: [],
        });

        expect(conflict).toEqual({
            flowId: 'welcome',
            flowName: 'Welcome',
            button: { messageKey: 'rules-panel', buttonKey: 'verify' },
            messageName: 'Rules panel',
            buttonLabel: 'Verify',
        });
        expect(conflict && buttonClaimRefusal(conflict)).toBe(
            '"Welcome" already listens to "Verify" on "Rules panel". One flow per button — point this trigger at another.'
        );
    });

    it('lets a flow in another journey hold the same keys', () => {
        expect(
            buttonClaimConflict({
                flowId: 'gatekeeper',
                graph: pressing('verify'),
                flows: [flow('elsewhere', 'Elsewhere', true, pressing('verify'))],
                journeyFlowIds: new Set(['gatekeeper']),
                declarations: DECLARATIONS,
                posters: [],
            })
        ).toBeUndefined();
    });

    it('lets a switched-off flow hold the button', () => {
        expect(
            buttonClaimConflict({
                flowId: 'gatekeeper',
                graph: pressing('verify'),
                flows: [flow('welcome', 'Welcome', false, pressing('verify'))],
                journeyFlowIds: new Set(['gatekeeper', 'welcome']),
                declarations: DECLARATIONS,
                posters: [],
            })
        ).toBeUndefined();
    });

    it('lets two live flows of one journey hold different buttons', () => {
        expect(
            buttonClaimConflict({
                flowId: 'gatekeeper',
                graph: pressing('nope'),
                flows: [flow('welcome', 'Welcome', true, pressing('verify'))],
                journeyFlowIds: new Set(['gatekeeper', 'welcome']),
                declarations: DECLARATIONS,
                posters: [],
            })
        ).toBeUndefined();
    });

    it('never counts the flow against its own stored row', () => {
        expect(
            buttonClaimConflict({
                flowId: 'welcome',
                graph: pressing('verify'),
                flows: [flow('welcome', 'Welcome', true, pressing('verify'))],
                journeyFlowIds: new Set(['welcome']),
                declarations: DECLARATIONS,
                posters: [],
            })
        ).toBeUndefined();
    });

    it('names an emoji-only button by its emoji, never as ""', () => {
        const conflict = buttonClaimConflict({
            flowId: 'gatekeeper',
            graph: pressing('spicy'),
            flows: [flow('welcome', 'Welcome', true, pressing('spicy'))],
            journeyFlowIds: new Set(['gatekeeper', 'welcome']),
            declarations: DECLARATIONS,
            posters: [],
        });

        expect(conflict && buttonClaimRefusal(conflict)).toBe(
            '"Welcome" already listens to "🌶️" on "Rules panel". One flow per button — point this trigger at another.'
        );
    });

    describe("a block's button", () => {
        /** "poster"'s Post Embed, posting a "kneel" button under "Kneel, pet". */
        const POSTER_GRAPH: FlowGraph = {
            version: FLOW_GRAPH_VERSION,
            nodes: [
                {
                    id: 'post',
                    type: ACTION_POST_EMBED,
                    position: { x: 0, y: 0 },
                    data: {
                        channelId: '111111111111111111',
                        message: { embeds: [{ title: 'Kneel, pet' }] },
                        buttons: [{ key: 'kneel', label: 'Kneel', style: 'Primary' }],
                    },
                },
            ],
            edges: [],
        };

        function pressingBlock(flowId: string, nodeId: string, buttonKey: string): FlowGraph {
            return {
                version: FLOW_GRAPH_VERSION,
                nodes: [
                    {
                        id: 'press',
                        type: TRIGGER_BUTTON_CLICK,
                        position: { x: 0, y: 0 },
                        data: { button: { flowId, nodeId, buttonKey }, eligibility: { principal: 'anyone' } },
                    },
                ],
                edges: [],
            };
        }

        it('names a live flow of the journey on the exact same poster, node and key, and the post it is under', () => {
            // As `decidePut` calls it: the live flows only, the switched-off poster among the posters.
            const conflict = buttonClaimConflict({
                flowId: 'gatekeeper',
                graph: pressingBlock('poster', 'post', 'kneel'),
                flows: [flow('welcome', 'Welcome', true, pressingBlock('poster', 'post', 'kneel'))],
                journeyFlowIds: new Set(['gatekeeper', 'welcome', 'poster']),
                declarations: DECLARATIONS,
                posters: [flow('poster', 'Poster', false, POSTER_GRAPH)],
            });

            expect(conflict).toEqual({
                flowId: 'welcome',
                flowName: 'Welcome',
                button: { flowId: 'poster', nodeId: 'post', buttonKey: 'kneel' },
                messageName: 'Kneel, pet in Poster',
                buttonLabel: 'Kneel',
            });
        });

        it('lets another node, another key, another journey or a switched-off flow hold its own', () => {
            const claim = (flows: readonly ClaimingFlow[], journeyFlowIds: ReadonlySet<string>) =>
                buttonClaimConflict({
                    flowId: 'gatekeeper',
                    graph: pressingBlock('poster', 'post', 'kneel'),
                    flows,
                    journeyFlowIds,
                    declarations: DECLARATIONS,
                    posters: [],
                });
            const journey = new Set(['gatekeeper', 'welcome', 'poster']);

            expect(claim([flow('welcome', 'Welcome', true, pressingBlock('poster', 'other', 'kneel'))], journey)).toBeUndefined();
            expect(claim([flow('welcome', 'Welcome', true, pressingBlock('poster', 'post', 'beg'))], journey)).toBeUndefined();
            expect(claim([flow('welcome', 'Welcome', false, pressingBlock('poster', 'post', 'kneel'))], journey)).toBeUndefined();
            expect(
                claim([flow('welcome', 'Welcome', true, pressingBlock('poster', 'post', 'kneel'))], new Set(['gatekeeper']))
            ).toBeUndefined();
        });

        it("never matches a journey message's keys against a block's button", () => {
            expect(
                buttonClaimConflict({
                    flowId: 'gatekeeper',
                    graph: pressingBlock('poster', 'rules-panel', 'verify'),
                    flows: [flow('welcome', 'Welcome', true, pressing('verify'))],
                    journeyFlowIds: new Set(['gatekeeper', 'welcome']),
                    declarations: DECLARATIONS,
                    posters: [],
                })
            ).toBeUndefined();
        });
    });

    it('names the keys when the journey no longer declares the button', () => {
        expect(
            buttonClaimConflict({
                flowId: 'gatekeeper',
                graph: pressing('gone'),
                flows: [flow('welcome', 'Welcome', true, pressing('gone'))],
                journeyFlowIds: new Set(['gatekeeper', 'welcome']),
                declarations: DECLARATIONS,
                posters: [],
            })
        ).toMatchObject({ messageName: 'Rules panel', buttonLabel: 'gone' });
    });
});
