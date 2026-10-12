import { act, screen, waitFor, within } from '@testing-library/react';
import type { Client, PermissionsString } from 'discord.js';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ACTION_SEND_DM } from '../../src/features/flows/blocks/actionSendDM';
import { TRIGGER_BUTTON_CLICK } from '../../src/features/flows/blocks/triggerButtonClick';
import { FLOW_GRAPH_VERSION, type FlowGraph } from '../../src/features/flows/data/flowGraph';
import { ELIGIBILITY_CONFIG_KEY, OPEN_GATE } from '../../src/features/flows/engine/eligibility';
import { TestDiscord, type ServerChannel } from '../../src/shared/__tests__/support/testDiscord';
import { createSeedApi, type SeedApi } from './preview/scenario/seedApi';
import { bootBotForDashboard } from './support/bootBot';
import { buildDashboardApp } from './support/dashboardApp';
import { installDashboardApi } from './support/dashboardApi';
import { renderDashboard } from './support/renderDashboard';

/**
 * The builder toolbar against the real routes and TestDiscord.
 *
 * Its install face: uninstalling from the toolbar's inventory puts the toolbar back on
 * offering an install. The toolbar reads the same published-state query as the inventory
 * dialog, and nothing in the builder asks again after a teardown — so the button changes
 * only because the dialog's own re-read moved the answer the two share.
 *
 * Its Deploy button: the flow's trigger button lands in the channel its node names.
 * Redeploying, which retires the first message, is not driven here: TestDiscord does not
 * model deleting a message.
 */

const BOT_PERMISSIONS: readonly PermissionsString[] = ['ManageChannels', 'ManageRoles'];
const OPERATOR = { id: '100000000000000007', username: 'e2e-operator' };
const FLOW_NAME = 'Velvet rope';

interface InstalledFlow {
    readonly discord: TestDiscord;
    readonly client: Client<true>;
    readonly flowId: string;
    readonly lounge: ServerChannel;
    /** The real routes, for changing the guild behind the page's back. */
    readonly api: SeedApi;
    readonly guildPath: string;
    readonly flowPath: string;
}

const running: TestDiscord[] = [];

beforeAll(async () => {
    await bootBotForDashboard();
});

afterEach(async () => {
    for (const discord of running.splice(0)) await discord.destroy();
});

/** A guild with one flow that declared a single channel and has installed it. */
async function guildWithInstalledFlow(): Promise<InstalledFlow> {
    const discord = new TestDiscord();
    running.push(discord);
    const guild = discord.createGuild({ bot: { permissions: BOT_PERMISSIONS } });
    const staff = guild.createRole({ name: 'Staff' });
    const client = await discord.start();

    const faults: string[] = [];
    const api = createSeedApi(
        buildDashboardApp({ client, operator: OPERATOR, onFault: (fault) => faults.push(fault) }),
        discord
    );
    const guildPath = `/api/guilds/${guild.id}`;
    await api.send('PUT', `${guildPath}/settings`, { staffRoleIds: [staff.id] });
    const flow = await api.send<{ flowId: string }>('POST', `${guildPath}/flows`, { name: FLOW_NAME });
    const flowPath = `${guildPath}/flows/${flow.flowId}`;
    await api.send('PUT', `${flowPath}/resources`, {
        resources: [
            {
                key: 'vip-lounge',
                kind: 'textChannel',
                defaultName: 'vip-lounge',
                permissions: [{ audience: 'staff', access: 'readWrite' }],
            },
        ],
    });
    const installed = await api.send<{ applied: { resourceKey: string; discordId: string }[] }>(
        'POST',
        `${flowPath}/install`,
        {}
    );
    expect(faults).toEqual([]);

    const loungeId = installed.applied.find((entry) => entry.resourceKey === 'vip-lounge')?.discordId;
    if (!loungeId) throw new Error('The install created no lounge.');
    return { discord, client, flowId: flow.flowId, lounge: guild.channel(loungeId), api, guildPath, flowPath };
}

describe('the builder toolbar', () => {
    it('goes back to offering an install once its inventory has uninstalled everything', async () => {
        const installed = await guildWithInstalledFlow();
        installDashboardApi(installed.client, OPERATOR);
        const { user } = renderDashboard(`/flows/${installed.flowId}`);

        await user.click(await screen.findByRole('button', { name: 'Installed' }));
        await user.click(await screen.findByRole('menuitem', { name: /Uninstall from server/ }));
        const dialog = await screen.findByRole('dialog', { name: `What ${FLOW_NAME} has in your server` });
        await within(dialog).findByText('#vip-lounge');
        await user.click(within(dialog).getByRole('button', { name: 'Delete 1 resource' }));
        await user.click(within(dialog).getByRole('button', { name: 'Yes, delete 1 resource' }));

        await waitFor(() => expect(installed.lounge.exists).toBe(false));
        await within(dialog).findByText('Nothing live in the server yet. Install it from the builder first.');
        await user.click(within(dialog).getByRole('button', { name: 'Done' }));

        expect(await screen.findByRole('button', { name: 'Install 1' })).toBeTruthy();
        expect(screen.queryByRole('button', { name: 'Installed' })).toBeNull();
    });

    it('asks again what is live each time its inventory opens', async () => {
        // The dialog's own `staleTime: 0`, not the client's default, is what keeps an answer
        // from an earlier opening off screen: what is live may have changed since.
        const installed = await guildWithInstalledFlow();
        installDashboardApi(installed.client, OPERATOR);
        const { user } = renderDashboard(`/flows/${installed.flowId}`);

        await user.click(await screen.findByRole('button', { name: 'Installed' }));
        await user.click(await screen.findByRole('menuitem', { name: /Uninstall from server/ }));
        const first = await screen.findByRole('dialog', { name: `What ${FLOW_NAME} has in your server` });
        await within(first).findByText('#vip-lounge');
        await user.click(within(first).getByRole('button', { name: 'Done' }));
        await waitFor(() => expect(screen.queryByRole('dialog', { name: `What ${FLOW_NAME} has in your server` })).toBeNull());

        // Taken down behind the page's back — another operator, another tab.
        await installed.api.send('POST', `${installed.flowPath}/unpublish`, {});
        expect(installed.lounge.exists).toBe(false);

        await user.click(screen.getByRole('button', { name: 'Installed' }));
        await user.click(await screen.findByRole('menuitem', { name: /Uninstall from server/ }));
        const second = await screen.findByRole('dialog', { name: `What ${FLOW_NAME} has in your server` });
        await within(second).findByText('Nothing live in the server yet. Install it from the builder first.');
        expect(within(second).queryByText('#vip-lounge')).toBeNull();
    });

    it("reads the guild's roles and channels afresh each time a flow is opened", async () => {
        // The load's own `staleTime: 0`: a directory cached by an earlier opening would offer
        // channels deleted since.
        const installed = await guildWithInstalledFlow();
        const dashboard = installDashboardApi(installed.client, OPERATOR);
        const { router } = renderDashboard(`/flows/${installed.flowId}`);
        expect(await screen.findByText('All changes saved')).toBeTruthy();

        await act(() => router.navigate('/flows'));
        await screen.findByText(FLOW_NAME);
        await act(() => router.navigate(`/flows/${installed.flowId}`));
        expect(await screen.findByText('All changes saved')).toBeTruthy();

        const reads = (path: string): number =>
            dashboard.requests.filter((request) => request.method === 'GET' && request.path === path).length;
        expect(reads(`${installed.guildPath}/channels`)).toBe(2);
        expect(reads(`${installed.guildPath}/roles`)).toBe(2);
    });

    it('deploys the flow’s button into the channel its trigger names', async () => {
        const live = await guildWithLiveButtonFlow();
        installDashboardApi(live.client, OPERATOR);
        const { user } = renderDashboard(`/flows/${live.flowId}`);

        await user.click(await screen.findByRole('button', { name: 'Deploy' }));
        const dialog = await screen.findByRole('dialog', { name: 'Deploy flow' });
        await user.click(within(dialog).getByRole('button', { name: 'Deploy' }));

        expect(await screen.findByText('1 button(s) live in that channel. Go press one.')).toBeTruthy();
        expect(live.signals.messages).toEqual([
            expect.objectContaining({
                content: `**${BUTTON_FLOW_NAME}**`,
                components: [
                    expect.objectContaining({
                        components: [
                            expect.objectContaining({ label: BUTTON_LABEL, custom_id: `flow:${live.flowId}:${BUTTON_NODE_ID}` }),
                        ],
                    }),
                ],
            }),
        ]);
        expect(live.faults).toEqual([]);
    });

    it('keeps a selected card when Backspace is pressed inside a dialog over the canvas', async () => {
        // Every modal carries React Flow's `nokey` (the theme's default), so a key pressed
        // in a dialog never reaches the canvas's delete underneath it.
        const live = await guildWithLiveButtonFlow();
        installDashboardApi(live.client, OPERATOR);
        const { user } = renderDashboard(`/flows/${live.flowId}`);
        expect(await screen.findByText('All changes saved')).toBeTruthy();
        await waitFor(() => expect(cardsOnCanvas()).toHaveLength(2));

        // Selected from the keyboard, as React Flow allows: a pointer press runs d3-drag,
        // which jsdom's events cannot carry.
        const [card] = cardsOnCanvas();
        if (!card) throw new Error('The canvas has no card to select.');
        card.focus();
        await user.keyboard('{Enter}');
        await waitFor(() => expect(card.classList.contains('selected')).toBe(true));

        await user.click(screen.getByRole('button', { name: 'Deploy' }));
        const dialog = await screen.findByRole('dialog', { name: 'Deploy flow' });
        within(dialog).getByRole('button', { name: 'Deploy' }).focus();
        await user.keyboard('{Backspace}');

        expect(cardsOnCanvas()).toHaveLength(2);
        expect(screen.queryByText(/^Unsaved changes/)).toBeNull();
    });
});

/** Every card on the canvas — React Flow renders one element per node. */
const cardsOnCanvas = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>('.react-flow__node')];

const BUTTON_FLOW_NAME = 'Safeword check-in';
const BUTTON_NODE_ID = 'check-in';
const BUTTON_LABEL = 'Still green?';

interface LiveButtonFlow {
    readonly client: Client<true>;
    readonly flowId: string;
    /** The channel the button trigger names. */
    readonly signals: ServerChannel;
    /** What the dashboard app reported as faults, read after the page has run. */
    readonly faults: readonly string[];
}

/** A guild with one switched-on flow started by a button in `#signals`, never deployed. */
async function guildWithLiveButtonFlow(): Promise<LiveButtonFlow> {
    const discord = new TestDiscord();
    running.push(discord);
    const guild = discord.createGuild();
    const signals = guild.createTextChannel({ name: 'signals' });
    const client = await discord.start();

    const faults: string[] = [];
    const api = createSeedApi(
        buildDashboardApp({ client, operator: OPERATOR, onFault: (fault) => faults.push(fault) }),
        discord
    );
    const graph: FlowGraph = {
        version: FLOW_GRAPH_VERSION,
        nodes: [
            {
                id: BUTTON_NODE_ID,
                type: TRIGGER_BUTTON_CLICK,
                position: { x: 0, y: 0 },
                data: { channelId: signals.id, label: BUTTON_LABEL, style: 'Primary', [ELIGIBILITY_CONFIG_KEY]: OPEN_GATE },
            },
            { id: 'reassure', type: ACTION_SEND_DM, position: { x: 0, y: 160 }, data: { message: 'Noted. Carry on, you menace.' } },
        ],
        edges: [{ id: 'check-in-to-reassure', source: BUTTON_NODE_ID, target: 'reassure' }],
    };
    const guildPath = `/api/guilds/${guild.id}`;
    const flow = await api.send<{ flowId: string }>('POST', `${guildPath}/flows`, { name: BUTTON_FLOW_NAME, graph });
    await api.send('PUT', `${guildPath}/flows/${flow.flowId}`, { enabled: true });
    expect(faults).toEqual([]);

    return { client, flowId: flow.flowId, signals, faults };
}
