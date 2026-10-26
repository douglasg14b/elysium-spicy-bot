import type { ResourceDeclaration } from '@brattybot/web-sdk';
import { TRIGGER_BUTTON_CLICK } from '../../../../src/features/flows/blocks/triggerButtonClick';
import { FLOW_GRAPH_VERSION, type FlowGraph } from '../../../../src/features/flows/data/flowGraph';
import type { PreviewPage } from '../previewPages';
import type { SeedContext } from './seedScenario';

interface CreatedFlow {
    readonly flowId: string;
}

const CHANNEL_KEY = 'rules-and-consent';
const PANEL_KEY = 'rules-panel';

/**
 * The Button Click trigger's panel in the four states of the mockup's section 4
 * (`message-editor.mockup.html`): a journey with no messages yet, picking a button with one
 * another flow already holds, the "+ New button" popover, and a pick whose button is gone.
 *
 * Three flows, each with one trigger on its canvas: "Rules gate" and "Welcome" share a journey
 * whose rules panel has three buttons, Welcome holding "Verify"; "Velvet rope" declares only a
 * channel; "Old door" picks a button its panel no longer has.
 */
export async function seedButtonClickTrigger({ guild, api }: SeedContext): Promise<PreviewPage[]> {
    const guildPath = `/api/guilds/${guild.guild.id}`;
    const createFlow = (name: string) => api.send<CreatedFlow>('POST', `${guildPath}/flows`, { name });
    const saveGraph = (flowId: string, pick?: { messageKey: string; buttonKey: string }) =>
        api.send('PUT', `${guildPath}/flows/${flowId}`, { graph: triggerOnly(pick) });

    // No messages yet: the journey declares a channel and nothing to press.
    const velvetRope = await createFlow('Velvet rope');
    await api.send('PUT', `${guildPath}/flows/${velvetRope.flowId}/resources`, { resources: [rulesChannel()] });
    await saveGraph(velvetRope.flowId);

    // Picking: two flows on one journey, grouped before anything is declared so the group
    // route names the journey, as `seedFlows` groups its munches.
    const rulesGate = await createFlow('Rules gate');
    const welcome = await createFlow('Welcome');
    await api.send('POST', `${guildPath}/flows/${welcome.flowId}/group`, {
        targetFlowId: rulesGate.flowId,
        newJourneyKey: 'front-of-house',
        newJourneyName: 'Front of house',
    });
    const journey = await api.send<{ updatedAt: string }>('GET', `${guildPath}/journeys/front-of-house`);
    await api.send('PUT', `${guildPath}/journeys/front-of-house`, {
        resources: [rulesChannel(), rulesPanel(['let-me-in', 'verify', 'read-the-rules'])],
        baseUpdatedAt: journey.updatedAt,
    });
    await saveGraph(welcome.flowId, { messageKey: PANEL_KEY, buttonKey: 'verify' });
    await saveGraph(rulesGate.flowId, { messageKey: PANEL_KEY, buttonKey: 'let-me-in' });

    // Gone: the pick names "verify", which its panel no longer has.
    const oldDoor = await createFlow('Old door');
    await api.send('PUT', `${guildPath}/flows/${oldDoor.flowId}/resources`, {
        resources: [rulesChannel(), rulesPanel(['let-me-in', 'read-the-rules'])],
    });
    await saveGraph(oldDoor.flowId, { messageKey: PANEL_KEY, buttonKey: 'verify' });

    const selectRulesGate = { clickText: 'Rules panel · Let me in' } as const;
    return [
        {
            name: 'button-trigger-no-messages',
            path: `/flows/${velvetRope.flowId}`,
            note: 'state 1: no messages yet, "+ New message in…" open — #rules-and-consent declared here, then the server',
            steps: [{ clickText: 'no button picked' }, { clickButton: 'New message in…' }],
        },
        {
            name: 'button-trigger-picking',
            path: `/flows/${rulesGate.flowId}`,
            note: 'state 2: the Button select open — "Let me in" says ↳ this flow, "Verify" greyed ↳ Welcome',
            steps: [selectRulesGate, { clickTextbox: 'Button' }],
        },
        {
            name: 'button-trigger-new-button',
            path: `/flows/${rulesGate.flowId}`,
            note: 'state 3: the "+ New button on this message" popover — Label with its counter, Style, Add',
            steps: [selectRulesGate, { clickButton: 'New button on this message' }],
        },
        {
            name: 'button-trigger-gone',
            path: `/flows/${oldDoor.flowId}`,
            note: 'state 4: a pick that\'s gone — "verify — not on this message any more", the issue under the pair',
            steps: [{ clickText: 'Rules panel · verify' }],
        },
    ];
}

/** One Button Click trigger, with `pick` if given, and nothing after it. */
function triggerOnly(pick?: { messageKey: string; buttonKey: string }): FlowGraph {
    return {
        version: FLOW_GRAPH_VERSION,
        nodes: [{ id: 'press', type: TRIGGER_BUTTON_CLICK, position: { x: 0, y: 0 }, data: pick ? { button: pick } : {} }],
        edges: [],
    };
}

function rulesChannel(): ResourceDeclaration {
    return { key: CHANNEL_KEY, kind: 'textChannel', defaultName: CHANNEL_KEY };
}

const BUTTONS = {
    'let-me-in': { key: 'let-me-in', label: 'Let me in', style: 'Success' },
    verify: { key: 'verify', label: 'Verify', style: 'Primary' },
    'read-the-rules': { key: 'read-the-rules', label: 'Read the rules', style: 'Secondary' },
} as const;

/** The rules panel in #rules-and-consent, with the named buttons in order. */
function rulesPanel(buttons: readonly (keyof typeof BUTTONS)[]): ResourceDeclaration {
    return {
        key: PANEL_KEY,
        kind: 'message',
        defaultName: 'Rules panel',
        parentKey: CHANNEL_KEY,
        message: {
            embeds: [
                {
                    title: 'House rules',
                    description: 'Consent first, every time. Read them all, then press the right button, darling.',
                },
            ],
        },
        buttons: buttons.map((key) => BUTTONS[key]),
    };
}
