import { screen, waitFor, within } from '@testing-library/react';
import type { Client } from 'discord.js';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ACTION_SEND_DM } from '../../src/features/flows/blocks/actionSendDM';
import { TRIGGER_MEMBER_JOIN } from '../../src/features/flows/blocks/triggerMemberJoin';
import { VARIABLE_NAME_MESSAGE } from '../../src/features/flows/blocks/variableName';
import { FLOW_GRAPH_VERSION, type FlowGraph } from '../../src/features/flows/data/flowGraph';
import { TestDiscord, type ServerGuild } from '../../src/shared/__tests__/support/testDiscord';
import { createSeedApi, type SeedApi } from './preview/scenario/seedApi';
import { bootBotForDashboard } from './support/bootBot';
import { buildDashboardApp } from './support/dashboardApp';
import { installDashboardApi } from './support/dashboardApi';
import { flowRow } from './support/flowRow';
import { renderDashboard } from './support/renderDashboard';

/**
 * An unfinished flow, end to end: it saves, it says what is missing wherever the operator
 * looks, and it cannot be switched on.
 *
 * Saving used to be all-or-nothing, so one empty field cost an operator every other edit
 * on the canvas. Now an incomplete graph is stored — and that is only safe because every
 * surface agrees it is not live: the builder marks it on open, the list flags it, and the
 * switch is refused by the server rather than merely hidden by the page. Each of those
 * has its own suite; only running them together shows the builder, the list and the route
 * describing the same stored graph.
 */

const OPERATOR = { id: '100000000000000002', username: 'e2e-operator' };
const FLOW_NAME = 'Half-baked greeter';
const DM_NODE_ID = 'greet-dm';

interface AuthoredFlow {
    readonly discord: TestDiscord;
    readonly client: Client<true>;
    readonly guild: ServerGuild;
    readonly api: SeedApi;
    readonly flowId: string;
    readonly flowPath: string;
}

interface StoredFlow {
    readonly enabled: boolean;
    readonly graph: FlowGraph;
    readonly issues: readonly { readonly nodeId?: string }[];
}

const running: TestDiscord[] = [];

beforeAll(async () => {
    await bootBotForDashboard();
});

afterEach(async () => {
    for (const discord of running.splice(0)) await discord.destroy();
});

/** A switched-off flow whose DM was left without a message — sound, but not ready. */
async function guildWithUnfinishedFlow(): Promise<AuthoredFlow> {
    const discord = new TestDiscord();
    running.push(discord);
    const guild = discord.createGuild();
    const client = await discord.start();

    const faults: string[] = [];
    const api = createSeedApi(
        buildDashboardApp({ client, operator: OPERATOR, onFault: (fault) => faults.push(fault) }),
        discord
    );
    const guildPath = `/api/guilds/${guild.id}`;
    const flow = await api.send<{ flowId: string }>('POST', `${guildPath}/flows`, { name: FLOW_NAME });
    const flowPath = `${guildPath}/flows/${flow.flowId}`;

    const graph: FlowGraph = {
        version: FLOW_GRAPH_VERSION,
        nodes: [
            { id: 'on-join', type: TRIGGER_MEMBER_JOIN, position: { x: 0, y: 0 }, data: {} },
            { id: DM_NODE_ID, type: ACTION_SEND_DM, position: { x: 0, y: 160 }, data: { message: '' } },
        ],
        edges: [{ id: 'join-to-dm', source: 'on-join', target: DM_NODE_ID }],
    };
    // Through the route, the way the builder saves: stored because the flow is off.
    const saved = await api.send<StoredFlow>('PUT', flowPath, { graph });
    expect(saved.issues.map((issue) => issue.nodeId)).toEqual([DM_NODE_ID]);
    expect(faults).toEqual([]);

    return { discord, client, guild, api, flowId: flow.flowId, flowPath };
}

describe('an unfinished flow', () => {
    it('opens marked, saves unfinished, is flagged on the list, and cannot be switched on', async () => {
        const authored = await guildWithUnfinishedFlow();
        const dashboard = installDashboardApi(authored.client, OPERATOR);
        const { user } = renderDashboard(`/flows/${authored.flowId}`);

        // Opened, not saved: the card is already red, from the issues the flow came with.
        expect(await screen.findByText('Open it — one problem to fix.')).toBeTruthy();

        // A second unfinished block — a DM dropped in with nothing to say — and a save.
        // Stored anyway, and the page says what that means rather than calling it done.
        await user.click(screen.getByTitle('Send DM — drag onto the canvas, or click to add'));
        await user.click(screen.getByRole('button', { name: 'Save' }));
        expect(
            await screen.findByText('Saved — 2 problems to fix before this flow can go live.')
        ).toBeTruthy();
        expect(screen.getByText('All changes saved')).toBeTruthy();
        // The builder's own switch will not offer what the server would refuse.
        expect((screen.getByRole('switch', { name: 'Enabled' }) as HTMLInputElement).disabled).toBe(true);

        // The server holds the half-finished graph, not the one it started with.
        const stored = await authored.api.send<StoredFlow>('GET', authored.flowPath);
        expect(stored.graph.nodes).toHaveLength(3);
        expect(stored.issues).toHaveLength(2);

        // The list flags it.
        await user.click(screen.getByRole('button', { name: 'Back to flows' }));
        const row = await flowRow(FLOW_NAME);
        expect(within(row).getByText('Needs fixes')).toBeTruthy();

        // Switching it on is refused by the server, and the switch goes back.
        const toggle = within(row).getByRole('switch', { name: `Enable ${FLOW_NAME}` });
        await user.click(toggle);
        expect(await screen.findByText('Fix 2 problems before turning this flow on.')).toBeTruthy();
        await waitFor(() => expect((toggle as HTMLInputElement).checked).toBe(false));
        expect(dashboard.requests).toContainEqual({ method: 'PUT', path: authored.flowPath });
        expect((await authored.api.send<StoredFlow>('GET', authored.flowPath)).enabled).toBe(false);

        // And the refusal is one click from the fix: the builder reopens the stored graph,
        // both unfinished blocks still marked.
        await user.click(screen.getByRole('button', { name: 'Fix it in the builder' }));
        await waitFor(() => expect(screen.getAllByText('Open it — one problem to fix.')).toHaveLength(2));
    });

    it('checks a field as the operator types, and has the server agree as they leave it', async () => {
        const authored = await guildWithUnfinishedFlow();
        const dashboard = installDashboardApi(authored.client, OPERATOR);
        const { user } = renderDashboard(`/flows/${authored.flowId}`);
        expect(await screen.findByText('Open it — one problem to fix.')).toBeTruthy();

        // A second DM with nothing to say, saved, so both are marked and the new one —
        // selected as it was added — shows its field in red.
        await user.click(screen.getByTitle('Send DM — drag onto the canvas, or click to add'));
        await user.click(screen.getByRole('button', { name: 'Save' }));
        expect(
            await screen.findByText('Saved — 2 problems to fix before this flow can go live.')
        ).toBeTruthy();
        const message = screen.getByRole('textbox', { name: 'Message' });
        expect(message.getAttribute('aria-invalid')).toBe('true');
        expect(screen.getByText('Fill this in.')).toBeTruthy();
        const check = { method: 'POST', path: `${authored.flowPath}/check` };

        // The first keystroke clears it, with nothing asked of the server — and only this
        // field's mark goes: the other DM is still marked.
        await user.type(message, 'W');
        expect(message.getAttribute('aria-invalid')).not.toBe('true');
        expect(screen.getAllByText('Open it — one problem to fix.')).toHaveLength(1);
        expect(dashboard.requests).not.toContainEqual(check);

        // Emptied again, it says so straight away, in the words the server used.
        await user.clear(message);
        expect(message.getAttribute('aria-invalid')).toBe('true');
        expect(screen.getByText('Fill this in.')).toBeTruthy();

        // Leaving the field asks the server, which agrees.
        await user.type(message, 'Welcome in');
        await user.tab();
        await waitFor(() => expect(dashboard.requests).toContainEqual(check));
        await waitFor(() => expect(screen.getAllByText('Open it — one problem to fix.')).toHaveLength(1));
        expect(message.getAttribute('aria-invalid')).not.toBe('true');

        // Asked, not saved: the stored graph still has both problems, so the switch
        // stays locked.
        expect((screen.getByRole('switch', { name: 'Enabled' }) as HTMLInputElement).disabled).toBe(true);
        expect((await authored.api.send<StoredFlow>('GET', authored.flowPath)).issues).toHaveLength(2);
    });

    it('checks a pattern as the operator types, in the block’s own words', async () => {
        const authored = await guildWithUnfinishedFlow();
        const dashboard = installDashboardApi(authored.client, OPERATOR);
        const { user } = renderDashboard(`/flows/${authored.flowId}`);
        expect(await screen.findByText('Open it — one problem to fix.')).toBeTruthy();

        // The variable-name rule reaches the browser with the SDK, sentence and all: no
        // server is asked before the mark appears.
        await user.click(screen.getByTitle('Set Variable — drag onto the canvas, or click to add'));
        const name = screen.getByRole('textbox', { name: 'Name' });
        await user.clear(name);
        await user.type(name, '1abc');
        expect(name.getAttribute('aria-invalid')).toBe('true');
        expect(screen.getByText(VARIABLE_NAME_MESSAGE)).toBeTruthy();
        expect(dashboard.requests).not.toContainEqual({ method: 'POST', path: `${authored.flowPath}/check` });

        // Fixed, the mark goes on the next keystroke.
        await user.clear(name);
        await user.type(name, 'greeting');
        expect(name.getAttribute('aria-invalid')).not.toBe('true');
        expect(screen.queryByText(VARIABLE_NAME_MESSAGE)).toBeNull();
    });
});
