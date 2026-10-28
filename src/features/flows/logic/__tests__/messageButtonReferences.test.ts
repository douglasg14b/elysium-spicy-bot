import { beforeAll, describe, expect, it } from 'vitest';
import type { ResourceDeclaration } from '../../../provisioning/logic/resourceDeclaration';
import { TRIGGER_BUTTON_CLICK } from '../../blocks/triggerButtonClick';
import { ensureBlocksDiscovered } from '../../blocks/registry';
import { FLOW_GRAPH_VERSION, type FlowGraph } from '../../data/flowGraph';
import { flowReadinessIssues } from '../flowReadiness';
import { messageButtonIssues } from '../messageButtonReferences';
import type { ReadinessScope } from '../readinessScope';

/**
 * The message-button half of readiness: a Button Click must name a message its journey
 * declares, and one of that message's buttons — and only one trigger in a flow may name it.
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

/** A flow on that journey, alone in it. */
const SCOPE: ReadinessScope = { flowId: 'flow-1', declarations: DECLARATIONS, journeyFlows: [] };

/** Button Click nodes, one per value, ids `press-1`, `press-2`, … */
function pressing(...buttons: unknown[]): FlowGraph {
    return {
        version: FLOW_GRAPH_VERSION,
        nodes: buttons.map((button, index) => ({
            id: `press-${index + 1}`,
            type: TRIGGER_BUTTON_CLICK,
            position: { x: index * 200, y: 0 },
            data: { button, eligibility: { principal: 'anyone' } },
        })),
        edges: [],
    };
}

beforeAll(async () => {
    await ensureBlocksDiscovered();
});

describe('messageButtonIssues', () => {
    it('passes a pick naming a declared message and one of its buttons', () => {
        expect(messageButtonIssues(pressing({ messageKey: 'rules-panel', buttonKey: 'verify' }), DECLARATIONS)).toEqual([]);
    });

    it('blames a message key the journey does not declare', () => {
        expect(messageButtonIssues(pressing({ messageKey: 'old-panel', buttonKey: 'verify' }), DECLARATIONS)).toEqual([
            {
                nodeId: 'press-1',
                field: 'button',
                message: 'This flow\'s resources have no message "old-panel". Pick another.',
            },
        ]);
    });

    it('blames a key naming a channel, which is no message', () => {
        expect(messageButtonIssues(pressing({ messageKey: 'rules', buttonKey: 'verify' }), DECLARATIONS)).toEqual([
            { nodeId: 'press-1', field: 'button', message: 'This flow\'s resources have no message "rules". Pick another.' },
        ]);
    });

    it('blames a button key the message no longer has', () => {
        expect(messageButtonIssues(pressing({ messageKey: 'rules-panel', buttonKey: 'gone' }), DECLARATIONS)).toEqual([
            { nodeId: 'press-1', field: 'button', message: '"Rules panel" has no button "gone" any more. Pick another.' },
        ]);
    });

    it('blames each of two triggers on one button, and neither of two on different buttons', () => {
        const clash = pressing(
            { messageKey: 'rules-panel', buttonKey: 'verify' },
            { messageKey: 'rules-panel', buttonKey: 'nope' },
            { messageKey: 'rules-panel', buttonKey: 'verify' }
        );

        expect(messageButtonIssues(clash, DECLARATIONS)).toEqual([
            {
                nodeId: 'press-1',
                field: 'button',
                message: 'Two triggers in this flow listen to "Verify". One press starts one run.',
            },
            {
                nodeId: 'press-3',
                field: 'button',
                message: 'Two triggers in this flow listen to "Verify". One press starts one run.',
            },
        ]);
    });

    it('does not also call two picks of a missing message a clash: picking again fixes both', () => {
        const issues = messageButtonIssues(
            pressing({ messageKey: 'old-panel', buttonKey: 'verify' }, { messageKey: 'old-panel', buttonKey: 'verify' }),
            DECLARATIONS
        );

        expect(issues.map((issue) => issue.message)).toEqual([
            'This flow\'s resources have no message "old-panel". Pick another.',
            'This flow\'s resources have no message "old-panel". Pick another.',
        ]);
    });

    it("leaves an empty or misshapen value to the schema's own complaint", () => {
        expect(messageButtonIssues(pressing(undefined, {}, 'x', { messageKey: 'rules-panel' }), DECLARATIONS)).toEqual([]);
    });
});

describe('readiness, on declarations', () => {
    it('asks messageButtonIssues, so the builder, the list and the switch-on gate agree', () => {
        expect(flowReadinessIssues(pressing({ messageKey: 'rules-panel', buttonKey: 'gone' }), SCOPE)).toEqual([
            { nodeId: 'press-1', field: 'button', message: '"Rules panel" has no button "gone" any more. Pick another.' },
        ]);
    });

    it('says "Fill this in." about a trigger with no button picked', () => {
        const graph = pressing(undefined);
        delete graph.nodes[0]!.data.button;

        expect(flowReadinessIssues(graph, SCOPE)).toEqual([
            expect.objectContaining({ nodeId: 'press-1', field: 'button', message: expect.stringMatching(/Fill this in/) }),
        ]);
    });
});
