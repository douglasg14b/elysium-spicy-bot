import { randomUUID } from 'crypto';
import type { ResourceDeclaration } from '../../provisioning/logic/resourceDeclaration';
import type { FlowGraph } from '../data/flowGraph';
import { FLOW_GRAPH_VERSION } from '../data/flowGraph';
import { ACTION_ASSIGN_ROLE } from '../blocks/actionAssignRole';
import { ACTION_SEND_DM } from '../blocks/actionSendDM';
import { TRIGGER_BUTTON_CLICK } from '../blocks/triggerButtonClick';

/** The keys the template's journey declares, which its trigger names. */
const RULES_CHANNEL_KEY = 'rules-channel';
const RULES_PANEL_KEY = 'rules-panel';
const AGREE_BUTTON_KEY = 'agree-to-rules';

export interface OnboardingFlowInput {
    /** Role granted when the member agrees to the rules. */
    memberRoleId: string;
    /**
     * Channel the rules panel — the message carrying the agree button — is posted in.
     *
     * Adopted by the journey's `textChannel` rather than created: a server running this
     * already has its rules channel.
     */
    channelId: string;
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
 * The button is not the trigger's own: it is a button on the rules panel, a message
 * resource of the flow's journey, which `resources` declares — the given channel, adopted,
 * and the panel posted in it. The trigger names the panel and its button by key.
 *
 * Shared by the seed script and the executor test so both exercise the exact
 * same graph.
 */
export function buildOnboardingFlowGraph(input: OnboardingFlowInput): {
    graph: FlowGraph;
    nodeIds: OnboardingFlowNodeIds;
    resources: readonly ResourceDeclaration[];
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
                data: {
                    button: { messageKey: RULES_PANEL_KEY, buttonKey: AGREE_BUTTON_KEY },
                    eligibility: { principal: 'anyone' },
                },
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

    const resources: readonly ResourceDeclaration[] = [
        {
            key: RULES_CHANNEL_KEY,
            kind: 'textChannel',
            defaultName: 'rules',
            adoptDiscordId: input.channelId,
        },
        {
            key: RULES_PANEL_KEY,
            kind: 'message',
            defaultName: 'Rules panel',
            parentKey: RULES_CHANNEL_KEY,
            message: {
                embeds: [
                    {
                        title: 'House Rules',
                        description:
                            'Read them. All of them. Then press the button and swear you did — we will know if you lied.',
                    },
                ],
            },
            buttons: [{ key: AGREE_BUTTON_KEY, label: input.buttonLabel ?? 'Agree to Rules', style: 'Success' }],
        },
    ];

    return { graph, nodeIds: { trigger: triggerId, assignRole: assignRoleId, sendDM: sendDMId }, resources };
}
