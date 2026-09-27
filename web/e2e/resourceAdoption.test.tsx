import { screen, waitFor, within } from '@testing-library/react';
import type { Client, PermissionsString } from 'discord.js';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ACTION_SEND_MESSAGE } from '../../src/features/flows/blocks/actionSendMessage';
import { TRIGGER_MEMBER_JOIN } from '../../src/features/flows/blocks/triggerMemberJoin';
import { FLOW_GRAPH_VERSION, type FlowGraph } from '../../src/features/flows/data/flowGraph';
import {
    TestDiscord,
    type ServerChannel,
    type ServerGuild,
} from '../../src/shared/__tests__/support/testDiscord';
import { createSeedApi, type SeedApi } from './preview/scenario/seedApi';
import { bootBotForDashboard } from './support/bootBot';
import { buildDashboardApp } from './support/dashboardApp';
import { installDashboardApi } from './support/dashboardApi';
import { renderDashboard } from './support/renderDashboard';

/**
 * Adopting a channel the guild already has, end to end: in the builder the operator points
 * a declared channel at the existing `#rules` instead of letting install create one, the
 * wizard says it will adopt, and the install creates nothing while wiring the real channel's
 * id into the flow that picked the declaration.
 *
 * Adoption is a promise made across every layer. The panel records which object was picked,
 * the autosave carries it to the server, the plan decides `adopt` by reading the guild, the
 * apply must leave the object alone, and the write-back must put *that* object's id into the
 * graph. Each layer has its own suite; only running them together shows that the id the
 * operator picked is the id the flow ends up with, and that Discord was not written to on
 * the way.
 */

const BOT_PERMISSIONS: readonly PermissionsString[] = ['ManageChannels', 'ManageRoles'];
const OPERATOR = { id: '100000000000000002', username: 'e2e-operator' };
const FLOW_NAME = 'Rules greeter';
const RESOURCE_KEY = 'rules-channel';
const SEND_NODE_ID = 'send-rules';

interface AuthoredFlow {
    readonly discord: TestDiscord;
    readonly client: Client<true>;
    readonly guild: ServerGuild;
    readonly rules: ServerChannel;
    readonly api: SeedApi;
    readonly flowId: string;
    /** The flow's API path, `/api/guilds/:guildId/flows/:flowId`. */
    readonly flowPath: string;
}

interface StoredResource {
    readonly key: string;
    readonly defaultName: string;
    readonly adoptDiscordId?: string;
}

const running: TestDiscord[] = [];

beforeAll(async () => {
    await bootBotForDashboard();
});

afterEach(async () => {
    for (const discord of running.splice(0)) await discord.destroy();
});

/**
 * A guild that already has `#rules`, and a flow declaring a channel of its own that a
 * Send Message node has picked. The declaration is named differently from `#rules` so
 * that nothing but the operator's pick can connect the two.
 */
async function guildWithRulesAndAFlow(): Promise<AuthoredFlow> {
    const discord = new TestDiscord();
    running.push(discord);
    const guild = discord.createGuild({ bot: { permissions: BOT_PERMISSIONS } });
    const staff = guild.createRole({ name: 'Staff' });
    const rules = guild.createTextChannel({ name: 'rules' });
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
        resources: [{ key: RESOURCE_KEY, kind: 'textChannel', defaultName: 'house-rules' }],
    });

    // The node holds an empty snowflake beside the declaration's key: the shape a picker
    // leaves when it chose a resource that is not installed yet.
    const graph: FlowGraph = {
        version: FLOW_GRAPH_VERSION,
        nodes: [
            { id: 'on-join', type: TRIGGER_MEMBER_JOIN, position: { x: 0, y: 0 }, data: {} },
            {
                id: SEND_NODE_ID,
                type: ACTION_SEND_MESSAGE,
                position: { x: 0, y: 160 },
                data: { channelId: '', channelIdKey: RESOURCE_KEY, message: 'Read the rules before you misbehave.' },
            },
        ],
        edges: [{ id: 'join-to-send', source: 'on-join', target: SEND_NODE_ID }],
    };
    await api.send('PUT', flowPath, { graph });
    expect(faults).toEqual([]);

    return { discord, client, guild, rules, api, flowId: flow.flowId, flowPath };
}

describe('adopting an existing channel from the builder', () => {
    it('adopts #rules instead of creating a channel, and wires its id into the flow', async () => {
        const authored = await guildWithRulesAndAFlow();
        const channelsBefore = authored.discord.clientGuild(authored.guild).channels.cache.size;
        const dashboard = installDashboardApi(authored.client, OPERATOR);
        const { user } = renderDashboard(`/flows/${authored.flowId}`);

        // Point the declaration at #rules, the way the resources panel offers it: clear the
        // name to search, and pick the existing channel from the suggestions.
        await user.click(await screen.findByRole('button', { name: /^Resources/ }));
        const resourcesDialog = await screen.findByRole('dialog', { name: 'Resources this flow needs' });
        await user.click(await within(resourcesDialog).findByRole('button', { name: 'Expand house-rules' }));
        await user.clear(within(resourcesDialog).getByRole('textbox', { name: 'Name' }));
        await user.click(await screen.findByRole('option', { name: '#rules' }));

        // The autosave carries the pick to the server, keeping the key the node names.
        await waitFor(async () => {
            const stored = await authored.api.send<{ resources: StoredResource[] }>('GET', `${authored.flowPath}/resources`);
            expect(stored.resources).toEqual([
                expect.objectContaining({ key: RESOURCE_KEY, defaultName: 'rules', adoptDiscordId: authored.rules.id }),
            ]);
        });
        await user.keyboard('{Escape}{Escape}');
        await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Resources this flow needs' })).toBeNull());

        // The wizard says adopt, and names the channel it will adopt.
        await user.click(screen.getByRole('button', { name: 'Install 1' }));
        const wizard = await screen.findByRole('dialog', { name: 'Install what this flow needs' });
        expect(await within(wizard).findByText('Adopt')).toBeTruthy();
        expect(within(wizard).getByText('rules')).toBeTruthy();
        expect(within(wizard).queryByText('Create')).toBeNull();
        await user.click(within(wizard).getByRole('button', { name: 'Install' }));
        await user.click(within(wizard).getByRole('button', { name: 'Yes, build it' }));
        await waitFor(() =>
            expect(dashboard.requests).toContainEqual({ method: 'POST', path: `${authored.flowPath}/install` })
        );

        // The flow's side: the node now names #rules by its real id.
        await waitFor(async () => {
            const saved = await authored.api.send<{ graph: FlowGraph }>('GET', authored.flowPath);
            const sendNode = saved.graph.nodes.find((node) => node.id === SEND_NODE_ID);
            expect(sendNode?.data).toMatchObject({ channelId: authored.rules.id, channelIdKey: RESOURCE_KEY });
        });

        // Discord's side: no channel was created, and #rules was not written to.
        authored.discord.flushGateway();
        expect(authored.discord.clientGuild(authored.guild).channels.cache.size).toBe(channelsBefore);
        expect(authored.discord.requests.filter((request) => request.method !== 'GET')).toEqual([]);
        expect(authored.rules.exists).toBe(true);
        expect(authored.rules.name).toBe('rules');
    });
});
