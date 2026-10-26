import { fireEvent, screen, waitFor } from '@testing-library/react';
import type { Client } from 'discord.js';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { TRIGGER_BUTTON_CLICK } from '../../src/features/flows/blocks/triggerButtonClick';
import { FLOW_GRAPH_VERSION, type FlowGraph } from '../../src/features/flows/data/flowGraph';
import { TestDiscord, type ServerChannel, type ServerGuild } from '../../src/shared/__tests__/support/testDiscord';
import { STALE_RESOURCES_MESSAGE } from '../src/flows/resourceSaveQueue';
import { createSeedApi, type SeedApi } from './preview/scenario/seedApi';
import { bootBotForDashboard } from './support/bootBot';
import { buildDashboardApp } from './support/dashboardApp';
import { installDashboardApi, type DashboardRequest } from './support/dashboardApi';
import { renderDashboard } from './support/renderDashboard';

/**
 * Where the builder saves its Resources, end to end (step 3, pick 7): a flow on no journey yet
 * saves through the flow — the route that creates its journey and writes the link — and every
 * save after that goes through the journey, carrying the version the first one answered with.
 *
 * Driven from the Button Click trigger's "+ New message in…" and "+ New button" rather than the
 * Resources window, so it also shows the declarations save while that window is shut: the
 * trigger writes into Resources, and nothing would reach the server if the autosave lived
 * inside the window.
 */

const OPERATOR = { id: '100000000000000005', username: 'e2e-operator' };

interface AuthoredFlow {
    readonly client: Client<true>;
    readonly guild: ServerGuild;
    readonly lobby: ServerChannel;
    readonly api: SeedApi;
    readonly flowId: string;
    readonly guildPath: string;
    readonly flowPath: string;
}

interface StoredJourney {
    readonly resources: readonly {
        readonly key: string;
        readonly kind: string;
        readonly adoptDiscordId?: string;
        readonly parentKey?: string;
        readonly buttons?: readonly { readonly key: string; readonly label: string }[];
    }[];
}

const running: TestDiscord[] = [];

beforeAll(async () => {
    await bootBotForDashboard();
});

afterEach(async () => {
    for (const discord of running.splice(0)) await discord.destroy();
});

/** A switched-off flow on no journey, holding one Button Click trigger with nothing picked. */
async function guildWithAnUnlinkedTrigger(): Promise<AuthoredFlow> {
    const discord = new TestDiscord();
    running.push(discord);
    const guild = discord.createGuild({ bot: { permissions: ['ViewChannel', 'SendMessages'] } });
    const lobby = guild.createTextChannel({ name: 'lobby' });
    const client = await discord.start();

    const api = createSeedApi(buildDashboardApp({ client, operator: OPERATOR, onFault: () => undefined }), discord);
    const guildPath = `/api/guilds/${guild.id}`;
    const flow = await api.send<{ flowId: string }>('POST', `${guildPath}/flows`, { name: 'Rules gate' });
    const flowPath = `${guildPath}/flows/${flow.flowId}`;
    const graph: FlowGraph = {
        version: FLOW_GRAPH_VERSION,
        nodes: [{ id: 'press', type: TRIGGER_BUTTON_CLICK, position: { x: 0, y: 0 }, data: {} }],
        edges: [],
    };
    await api.send('PUT', flowPath, { graph });

    return { client, guild, lobby, api, flowId: flow.flowId, guildPath, flowPath };
}

/** The index of the first request matching, at or after `from`; -1 when there is none. */
function indexOf(requests: readonly DashboardRequest[], wanted: DashboardRequest, from = 0): number {
    return requests.findIndex(
        (request, index) => index >= from && request.method === wanted.method && request.path === wanted.path
    );
}

describe("the builder's Resources saves", () => {
    it('go through the flow until it is linked, then through the journey, with the window shut', async () => {
        const authored = await guildWithAnUnlinkedTrigger();
        const dashboard = installDashboardApi(authored.client, OPERATOR);
        const { user } = renderDashboard(`/flows/${authored.flowId}`);
        const throughFlow: DashboardRequest = { method: 'PUT', path: `${authored.flowPath}/resources` };
        const attachmentRead: DashboardRequest = { method: 'GET', path: `${authored.flowPath}/attachment` };
        const throughJourney: DashboardRequest = {
            method: 'PUT',
            path: `${authored.guildPath}/journeys/${authored.flowId}`,
        };

        // Select the trigger by its summary line — a bare click, as `flowNextRun` explains.
        fireEvent.click(await screen.findByText(/no button picked/));
        await user.click(await screen.findByRole('button', { name: 'New message in…' }));
        await user.click(await screen.findByRole('menuitem', { name: /^#lobby/ }));

        // The first save: through the flow, which creates the journey and links it; then the
        // builder asks again which journey this is.
        await waitFor(() => expect(indexOf(dashboard.requests, throughFlow)).toBeGreaterThanOrEqual(0));
        const firstSave = indexOf(dashboard.requests, throughFlow);
        await waitFor(() => expect(indexOf(dashboard.requests, attachmentRead, firstSave)).toBeGreaterThan(firstSave));
        const linked = indexOf(dashboard.requests, attachmentRead, firstSave);

        // "+ New message" opened "+ New button", asking for the message's first one.
        await user.type(await screen.findByRole('textbox', { name: 'Label' }), 'Let me in');
        await user.click(screen.getByRole('button', { name: 'Add' }));

        await waitFor(() => expect(indexOf(dashboard.requests, throughJourney, linked)).toBeGreaterThan(linked));
        await waitFor(async () => {
            const stored = await authored.api.send<StoredJourney>(
                'GET',
                `${authored.guildPath}/journeys/${authored.flowId}`
            );
            expect(stored.resources).toEqual([
                expect.objectContaining({ key: 'lobby', kind: 'textChannel', adoptDiscordId: authored.lobby.id }),
                expect.objectContaining({
                    key: 'new-message',
                    kind: 'message',
                    parentKey: 'lobby',
                    buttons: [expect.objectContaining({ key: 'let-me-in', label: 'Let me in' })],
                }),
            ]);
        });

        // Only the first save went through the flow; no save was refused as stale.
        const flowSaves = dashboard.requests.filter(
            (request) => request.method === throughFlow.method && request.path === throughFlow.path
        );
        expect(flowSaves).toHaveLength(1);
        expect(screen.queryByText(/changed since|Reload/)).toBeNull();
        expect(screen.queryByRole('dialog', { name: 'Resources this flow needs' })).toBeNull();
    });

    it('say so in the server’s words when one the trigger started is refused with the window shut', async () => {
        const authored = await guildWithAnUnlinkedTrigger();
        const dashboard = installDashboardApi(authored.client, OPERATOR);
        const { user } = renderDashboard(`/flows/${authored.flowId}`);
        const journeyPath = `${authored.guildPath}/journeys/${authored.flowId}`;
        const throughFlow: DashboardRequest = { method: 'PUT', path: `${authored.flowPath}/resources` };
        const attachmentRead: DashboardRequest = { method: 'GET', path: `${authored.flowPath}/attachment` };

        fireEvent.click(await screen.findByText(/no button picked/));
        await user.click(await screen.findByRole('button', { name: 'New message in…' }));
        await user.click(await screen.findByRole('menuitem', { name: /^#lobby/ }));
        await waitFor(() => expect(indexOf(dashboard.requests, throughFlow)).toBeGreaterThanOrEqual(0));
        const firstSave = indexOf(dashboard.requests, throughFlow);
        await waitFor(() => expect(indexOf(dashboard.requests, attachmentRead, firstSave)).toBeGreaterThan(firstSave));

        // Somebody else saves the journey after this tab's first save answered: its version moves on.
        const stored = await authored.api.send<StoredJourney & { updatedAt: string }>('GET', journeyPath);
        await authored.api.send('PUT', journeyPath, { resources: stored.resources, baseUpdatedAt: stored.updatedAt });

        await user.type(await screen.findByRole('textbox', { name: 'Label' }), 'Let me in');
        await user.click(screen.getByRole('button', { name: 'Add' }));

        // Refused as stale, and said where the operator is working, not inside a shut window.
        expect(await screen.findByText(STALE_RESOURCES_MESSAGE)).toBeTruthy();
        expect(screen.queryByRole('dialog', { name: 'Resources this flow needs' })).toBeNull();
        const after = await authored.api.send<StoredJourney>('GET', journeyPath);
        expect(after.resources.find((resource) => resource.kind === 'message')?.buttons ?? []).toEqual([]);
    });
});
