import { screen, waitFor, within } from '@testing-library/react';
import type { Client, PermissionsString } from 'discord.js';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
    TestDiscord,
    type ServerGuild,
    type ServerRole,
} from '../../src/shared/__tests__/support/testDiscord';
import { createSeedApi } from './preview/scenario/seedApi';
import { bootBotForDashboard } from './support/bootBot';
import { buildDashboardApp } from './support/dashboardApp';
import { installDashboardApi } from './support/dashboardApi';
import { flowRow } from './support/flowRow';
import { renderDashboard } from './support/renderDashboard';

/**
 * Installing a flow from the flows list, end to end: the list hands off to the builder's
 * install wizard, the wizard installs through the real engine into TestDiscord, and the
 * list stops asking.
 *
 * The flow is authored through the API rather than the builder, because authoring is not
 * what is under test and the resources panel has its own suite.
 */

const BOT_PERMISSIONS: readonly PermissionsString[] = ['ManageChannels', 'ManageRoles'];
const OPERATOR = { id: '100000000000000002', username: 'e2e-operator' };
const FLOW_NAME = 'Lobby greeter';

interface AuthoredGuild {
    readonly discord: TestDiscord;
    readonly client: Client<true>;
    readonly guild: ServerGuild;
    readonly staff: ServerRole;
}

const running: TestDiscord[] = [];

beforeAll(async () => {
    await bootBotForDashboard();
});

afterEach(async () => {
    for (const discord of running.splice(0)) await discord.destroy();
});

/** A guild with staff configured and one flow declaring a category and a channel, not yet installed. */
async function guildWithUninstalledFlow(): Promise<AuthoredGuild> {
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
    await api.send('PUT', `${guildPath}/flows/${flow.flowId}/resources`, {
        resources: [
            {
                key: 'lobby-category',
                kind: 'category',
                defaultName: 'Lobby',
                permissions: [
                    { audience: 'everyone', access: 'hidden' },
                    { audience: 'staff', access: 'readWrite' },
                ],
            },
            {
                key: 'welcome-channel',
                kind: 'textChannel',
                defaultName: 'welcome',
                parentKey: 'lobby-category',
                // Declared rather than left to the category: whether Discord syncs a
                // category's overwrites onto a child created without any is something
                // TestDiscord refuses to guess.
                permissions: [
                    { audience: 'everyone', access: 'readOnly' },
                    { audience: 'staff', access: 'readWrite' },
                ],
            },
        ],
    });
    expect(faults).toEqual([]);

    return { discord, client, guild, staff };
}

describe('installing a flow from the flows list', () => {
    it('hands off to the builder, builds what the flow declares, and the list stops asking', async () => {
        const authored = await guildWithUninstalledFlow();
        installDashboardApi(authored.client, OPERATOR);
        const { user } = renderDashboard('/flows');

        const row = await flowRow(FLOW_NAME);
        expect(within(row).getByText('Not installed')).toBeTruthy();
        await user.click(within(row).getByRole('button', { name: 'Install' }));

        const wizard = await screen.findByRole('dialog', { name: 'Install what this flow needs' });
        expect(await within(wizard).findByText('Lobby')).toBeTruthy();
        expect(within(wizard).getByText('welcome')).toBeTruthy();
        await user.click(within(wizard).getByRole('button', { name: 'Install' }));
        await user.click(within(wizard).getByRole('button', { name: 'Yes, build it' }));

        // Discord's side: the channel exists under the category, and the category's
        // overwrites say what the declaration said.
        await waitFor(() => {
            expect(authored.discord.clientGuild(authored.guild).channels.cache.find((channel) => channel.name === 'welcome')).toBeTruthy();
        });
        authored.discord.flushGateway();
        const live = authored.discord.clientGuild(authored.guild).channels.cache;
        const category = authored.guild.channel(live.find((channel) => channel.name === 'Lobby')?.id ?? '');
        const welcome = authored.guild.channel(live.find((channel) => channel.name === 'welcome')?.id ?? '');
        expect(welcome.parentId).toBe(category.id);
        expect(category.overwriteFor(authored.guild.everyone)?.deny).toContain('ViewChannel');
        expect(category.overwriteFor(authored.staff)?.allow).toEqual(
            expect.arrayContaining(['ViewChannel', 'SendMessages'])
        );

        // The list's side: installed is the resting state, so the row goes quiet.
        await user.click(screen.getByRole('button', { name: 'Back to flows' }));
        const installedRow = await flowRow(FLOW_NAME);
        expect(within(installedRow).queryByText('Not installed')).toBeNull();
        expect(within(installedRow).queryByRole('button', { name: 'Install' })).toBeNull();
    });
});
