import { screen, waitFor, within } from '@testing-library/react';
import type { Client, PermissionsString } from 'discord.js';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ACTION_SEND_MESSAGE } from '../../src/features/flows/blocks/actionSendMessage';
import { TRIGGER_MEMBER_JOIN } from '../../src/features/flows/blocks/triggerMemberJoin';
import { FLOW_GRAPH_VERSION, type FlowGraph } from '../../src/features/flows/data/flowGraph';
import { TestDiscord, type ServerGuild } from '../../src/shared/__tests__/support/testDiscord';
import { createSeedApi, type SeedApi } from './preview/scenario/seedApi';
import { bootBotForDashboard } from './support/bootBot';
import { buildDashboardApp } from './support/dashboardApp';
import { installDashboardApi } from './support/dashboardApi';
import { flowRow } from './support/flowRow';
import { renderDashboard } from './support/renderDashboard';

/**
 * Installing a shared journey from its group header on the flows list, end to end: two
 * flows grouped into one journey, one Install on the header, and each thing the journey
 * declares is created in Discord exactly once — then wired into both flows.
 *
 * A journey is the unit of install, but the header hands off to the builder of one member
 * flow, and the resources were declared by different flows before the grouping merged
 * them. Whether that still adds up to one install of one set of resources depends on the
 * group route's merge, the list's hand-off, the builder's wizard, the engine, and the
 * write-back scoping to the journey's own flows. Counting the creates TestDiscord received
 * is the only place all of those answer at once.
 */

const BOT_PERMISSIONS: readonly PermissionsString[] = ['ManageChannels', 'ManageRoles'];
const OPERATOR = { id: '100000000000000002', username: 'e2e-operator' };
const SIGNUP_FLOW = 'Munch sign-up';
const REMINDER_FLOW = 'Munch reminder';
const JOURNEY_NAME = 'Munches';
const CHANNEL_KEY = 'munch-chat';

interface GroupedFlows {
    readonly discord: TestDiscord;
    readonly client: Client<true>;
    readonly guild: ServerGuild;
    readonly api: SeedApi;
    readonly flowPaths: readonly string[];
}

const running: TestDiscord[] = [];

beforeAll(async () => {
    await bootBotForDashboard();
});

afterEach(async () => {
    for (const discord of running.splice(0)) await discord.destroy();
});

/** A member-join flow whose one Send Message node picked the journey's channel. */
function graphPostingTo(resourceKey: string): FlowGraph {
    return {
        version: FLOW_GRAPH_VERSION,
        nodes: [
            { id: 'on-join', type: TRIGGER_MEMBER_JOIN, position: { x: 0, y: 0 }, data: {} },
            {
                id: 'announce',
                type: ACTION_SEND_MESSAGE,
                position: { x: 0, y: 160 },
                data: { channelId: '', channelIdKey: resourceKey, message: 'Fresh meat for the munch.' },
            },
        ],
        edges: [{ id: 'join-to-announce', source: 'on-join', target: 'announce' }],
    };
}

/** The `name` a create request carried, which every channel and role create sends. */
function nameIn(body: unknown): string {
    if (typeof body === 'object' && body !== null && 'name' in body && typeof body.name === 'string') return body.name;
    throw new Error(`A create request carried no name: ${JSON.stringify(body)}`);
}

/**
 * Two flows that each declared their own resources, then were grouped the way a drop on
 * the flows list groups them: the reminder moved onto the sign-up, its declarations merged.
 */
async function groupedFlows(): Promise<GroupedFlows> {
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

    const signup = await api.send<{ flowId: string }>('POST', `${guildPath}/flows`, { name: SIGNUP_FLOW });
    const reminder = await api.send<{ flowId: string }>('POST', `${guildPath}/flows`, { name: REMINDER_FLOW });
    const signupPath = `${guildPath}/flows/${signup.flowId}`;
    const reminderPath = `${guildPath}/flows/${reminder.flowId}`;

    await api.send('PUT', `${signupPath}/resources`, {
        resources: [
            {
                key: 'munch-category',
                kind: 'category',
                defaultName: 'Munches',
                permissions: [
                    { audience: 'everyone', access: 'readOnly' },
                    { audience: 'staff', access: 'readWrite' },
                ],
            },
            {
                key: CHANNEL_KEY,
                kind: 'textChannel',
                defaultName: 'munch-chat',
                parentKey: 'munch-category',
                // Declared rather than left to the category: whether Discord syncs a
                // category's overwrites onto a child created without any is something
                // TestDiscord refuses to guess.
                permissions: [
                    { audience: 'everyone', access: 'readWrite' },
                    { audience: 'staff', access: 'readWrite' },
                ],
            },
        ],
    });
    await api.send('PUT', `${reminderPath}/resources`, {
        resources: [{ key: 'munch-goer', kind: 'role', defaultName: 'Munch Goer' }],
    });

    const grouped = await api.send<{ journeyKey: string; resourceCount: number }>('POST', `${reminderPath}/group`, {
        targetFlowId: signup.flowId,
        resolution: 'merge',
    });
    expect(grouped.resourceCount).toBe(3);
    // Named apart from both flows, so the header is findable by its own name.
    await api.send('PUT', `${guildPath}/journeys/${grouped.journeyKey}`, { name: JOURNEY_NAME });

    // Both flows pick the same declared channel. Saved after grouping, because the
    // reminder only declares it through the journey it has just joined.
    await api.send('PUT', signupPath, { graph: graphPostingTo(CHANNEL_KEY) });
    await api.send('PUT', reminderPath, { graph: graphPostingTo(CHANNEL_KEY) });
    expect(faults).toEqual([]);

    return { discord, client, guild, api, flowPaths: [signupPath, reminderPath] };
}

describe('installing a shared journey from its group header', () => {
    it('creates each declared resource once and wires it into both flows', async () => {
        const grouped = await groupedFlows();
        const dashboard = installDashboardApi(grouped.client, OPERATOR);
        const { user } = renderDashboard('/flows');

        // The header carries the journey's install state; its members carry none of their own.
        const header = await flowRow(JOURNEY_NAME);
        expect(within(header).getByText('Not installed')).toBeTruthy();
        expect(within(await flowRow(SIGNUP_FLOW)).queryByRole('button', { name: 'Install' })).toBeNull();
        expect(within(await flowRow(REMINDER_FLOW)).queryByRole('button', { name: 'Install' })).toBeNull();
        await user.click(within(header).getByRole('button', { name: 'Install' }));

        const wizard = await screen.findByRole('dialog', { name: 'Install what this flow needs' });
        expect(await within(wizard).findByText('Munches')).toBeTruthy();
        expect(within(wizard).getByText('munch-chat')).toBeTruthy();
        expect(within(wizard).getByText('Munch Goer')).toBeTruthy();
        expect(within(wizard).getAllByText('Create')).toHaveLength(3);
        await user.click(within(wizard).getByRole('button', { name: 'Install' }));
        await user.click(within(wizard).getByRole('button', { name: 'Yes, build it' }));

        // Discord's side: one create per declaration, and the install ran once.
        await waitFor(() =>
            expect(grouped.discord.requests.filter((request) => request.method === 'POST')).toHaveLength(3)
        );
        grouped.discord.flushGateway();
        // Sorted: the order the engine applies them in is its own business.
        const creates = grouped.discord.requests
            .filter((request) => request.method === 'POST')
            .map((request) => `${request.path.endsWith('/roles') ? 'role' : 'channel'} ${nameIn(request.body)}`)
            .sort();
        expect(creates).toEqual(['channel Munches', 'channel munch-chat', 'role Munch Goer']);
        expect(dashboard.requests.filter((request) => request.path.endsWith('/install'))).toHaveLength(1);

        // The flows' side: both members now post to the one channel that was created.
        const live = grouped.discord.clientGuild(grouped.guild).channels.cache;
        const munchChatId = live.find((channel) => channel.name === 'munch-chat')?.id;
        expect(munchChatId).toMatch(/^\d{17,20}$/);
        for (const flowPath of grouped.flowPaths) {
            const saved = await grouped.api.send<{ graph: FlowGraph }>('GET', flowPath);
            const announce = saved.graph.nodes.find((node) => node.id === 'announce');
            expect(announce?.data).toMatchObject({ channelId: munchChatId, channelIdKey: CHANNEL_KEY });
        }

        // The list's side: the journey is installed, so the header goes quiet.
        await user.click(screen.getByRole('button', { name: 'Back to flows' }));
        const installedHeader = await flowRow(JOURNEY_NAME);
        expect(within(installedHeader).queryByText('Not installed')).toBeNull();
        expect(within(installedHeader).queryByRole('button', { name: 'Install' })).toBeNull();
    });
});
