import { beforeAll, describe, expect, it } from 'vitest';
import type { ResourceDeclaration } from '../../../provisioning/logic/resourceDeclaration';
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
        });

        expect(conflict).toEqual({
            flowId: 'welcome',
            flowName: 'Welcome',
            messageKey: 'rules-panel',
            buttonKey: 'verify',
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
            })
        ).toBeUndefined();
    });

    it('names the keys when the journey no longer declares the button', () => {
        expect(
            buttonClaimConflict({
                flowId: 'gatekeeper',
                graph: pressing('gone'),
                flows: [flow('welcome', 'Welcome', true, pressing('gone'))],
                journeyFlowIds: new Set(['gatekeeper', 'welcome']),
                declarations: DECLARATIONS,
            })
        ).toMatchObject({ messageName: 'Rules panel', buttonLabel: 'gone' });
    });
});
