import { randomUUID } from 'crypto';
import type { FlowGraph } from '../data/flowGraph';
import { FLOW_GRAPH_VERSION } from '../data/flowGraph';
import { ACTION_ASSIGN_ROLE } from '../blocks/actionAssignRole';
import { ACTION_SEND_DM } from '../blocks/actionSendDM';
import { TRIGGER_BUTTON_CLICK } from '../blocks/triggerButtonClick';

export interface OnboardingFlowInput {
    /** Role granted when the member agrees to the rules. */
    memberRoleId: string;
    /** Welcome DM sent after the role is assigned. */
    welcomeMessage: string;
    /** Label for the agree button (defaults to "Agree to Rules"). */
    buttonLabel?: string;
}

export interface OnboardingFlowNodeIds {
    trigger: string;
    assignRole: string;
    sendDM: string;
}

/**
 * Build the canonical onboarding FlowGraph:
 *   trigger.buttonClick ("Agree to Rules") -> action.assignRole -> action.sendDM.
 *
 * Shared by the seed script and the executor test so both exercise the exact
 * same graph.
 */
export function buildOnboardingFlowGraph(input: OnboardingFlowInput): {
    graph: FlowGraph;
    nodeIds: OnboardingFlowNodeIds;
} {
    const triggerId = randomUUID();
    const assignRoleId = randomUUID();
    const sendDMId = randomUUID();

    const graph: FlowGraph = {
        version: FLOW_GRAPH_VERSION,
        nodes: [
            {
                id: triggerId,
                type: TRIGGER_BUTTON_CLICK,
                position: { x: 0, y: 0 },
                data: { label: input.buttonLabel ?? 'Agree to Rules', style: 'Success' },
            },
            {
                id: assignRoleId,
                type: ACTION_ASSIGN_ROLE,
                position: { x: 260, y: 0 },
                data: { roleId: input.memberRoleId },
            },
            {
                id: sendDMId,
                type: ACTION_SEND_DM,
                position: { x: 520, y: 0 },
                data: { message: input.welcomeMessage },
            },
        ],
        edges: [
            { id: randomUUID(), source: triggerId, target: assignRoleId },
            { id: randomUUID(), source: assignRoleId, target: sendDMId },
        ],
    };

    return { graph, nodeIds: { trigger: triggerId, assignRole: assignRoleId, sendDM: sendDMId } };
}
