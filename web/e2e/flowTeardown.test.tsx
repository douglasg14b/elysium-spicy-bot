import { screen, waitFor, within } from '@testing-library/react';
import type { Client, PermissionsString } from 'discord.js';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
    TestDiscord,
    type ServerChannel,
    type ServerGuild,
} from '../../src/shared/__tests__/support/testDiscord';
import { createSeedApi } from './preview/scenario/seedApi';
import { bootBotForDashboard } from './support/bootBot';
import { buildDashboardApp } from './support/dashboardApp';
import { installDashboardApi } from './support/dashboardApi';
import { flowRow } from './support/flowRow';
import { renderDashboard } from './support/renderDashboard';

/**
 * Taking an installed flow back out of the server from the flows list, end to end: the
 * row's server-cog opens the inventory, the operator arms and confirms the counted delete,
 * the real unpublish route plans and applies the teardown through discord.js into
 * TestDiscord, and the list says the flow is no longer installed.
 *
 * Every layer is needed for the question to exist. What the dialog promises comes from a
 * plan the server builds by reading the guild; what is deleted is decided again at apply
 * time against the guild as it is then; and the row's chip is derived from the binding
 * table the teardown rewrites. A component test with a fake API can only check that the
 * dialog renders what it was handed, not that it was handed the truth.
 *
 * The flow is installed through the API rather than the wizard: installing has its own
 * scenario, and this one starts where that one ends.
 */

const BOT_PERMISSIONS: readonly PermissionsString[] = ['ManageChannels', 'ManageRoles'];
const OPERATOR = { id: '100000000000000002', username: 'e2e-operator' };
const FLOW_NAME = 'Lobby greeter';
const DIALOG_NAME = `What ${FLOW_NAME} has in your server`;

interface InstalledFlow {
    readonly discord: TestDiscord;
    readonly client: Client<true>;
    readonly guild: ServerGuild;
    readonly category: ServerChannel;
    readonly welcome: ServerChannel;
}

const running: TestDiscord[] = [];

beforeAll(async () => {
    await bootBotForDashboard();
});

afterEach(async () => {
    for (const discord of running.splice(0)) await discord.destroy();
});

/** A guild with one flow that declared a category and a channel inside it, installed. */
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
    const installed = await api.send<{ applied: { resourceKey: string; discordId: string }[] }>(
        'POST',
        `${guildPath}/flows/${flow.flowId}/install`,
        {}
    );
    expect(faults).toEqual([]);

    const idOf = (resourceKey: string): string => {
        const discordId = installed.applied.find((entry) => entry.resourceKey === resourceKey)?.discordId;
        if (!discordId) throw new Error(`The install created nothing for ${resourceKey}.`);
        return discordId;
    };

    return {
        discord,
        client,
        guild,
        category: guild.channel(idOf('lobby-category')),
        welcome: guild.channel(idOf('welcome-channel')),
    };
}

/** Open the row's inventory the way an operator does, and wait until it has asked the server. */
async function openInventory(user: ReturnType<typeof renderDashboard>['user']): Promise<HTMLElement> {
    const row = await flowRow(FLOW_NAME);
    await user.click(within(row).getByRole('button', { name: `Manage what ${FLOW_NAME} published` }));
    const dialog = await screen.findByRole('dialog', { name: DIALOG_NAME });
    await within(dialog).findByText('#welcome');
    return dialog;
}

describe('tearing down an installed flow from the flows list', () => {
    it('deletes what the flow created, and the row asks to be installed again', async () => {
        const installed = await guildWithInstalledFlow();
        installDashboardApi(installed.client, OPERATOR);
        const { user } = renderDashboard('/flows');

        // Installed is the resting state, so the row starts quiet.
        expect(within(await flowRow(FLOW_NAME)).queryByText('Not installed')).toBeNull();

        const dialog = await openInventory(user);
        expect(within(dialog).getByText('Created by this flow')).toBeTruthy();
        expect(within(dialog).getByText('Lobby')).toBeTruthy();
        expect(within(dialog).getAllByText('deletes')).toHaveLength(2);

        await user.click(within(dialog).getByRole('button', { name: 'Delete 2 resources' }));
        await user.click(within(dialog).getByRole('button', { name: 'Yes, delete 2 resources' }));

        // Discord's side: both gone, each by exactly one delete the bot sent.
        await waitFor(() => expect(installed.category.exists).toBe(false));
        expect(installed.welcome.exists).toBe(false);
        expect(installed.discord.writesTo(installed.welcome).map((request) => request.method)).toEqual(['DELETE']);
        expect(installed.discord.writesTo(installed.category).map((request) => request.method)).toEqual(['DELETE']);

        // The dialog re-reads after the teardown rather than trusting its own report.
        expect(
            await within(dialog).findByText('Nothing live in the server yet. Install it from the builder first.')
        ).toBeTruthy();

        // The list's side: nothing is installed, so the row says so and offers the fix.
        await user.click(within(dialog).getByRole('button', { name: 'Done' }));
        const row = await flowRow(FLOW_NAME);
        expect(await within(row).findByText('Not installed')).toBeTruthy();
        expect(within(row).getByRole('button', { name: 'Install' })).toBeTruthy();
    });

    it('keeps a category someone has since put a channel in, exactly as the dialog said it would', async () => {
        const installed = await guildWithInstalledFlow();
        // An operator adds a channel of their own to the flow's category in Discord.
        const handMade = installed.guild.createTextChannel({ name: 'hand-made', parent: installed.category });
        installDashboardApi(installed.client, OPERATOR);
        const { user } = renderDashboard('/flows');

        const dialog = await openInventory(user);
        // Only the channel dies; the category is held back, and the reason names what is in it.
        expect(within(dialog).getAllByText('deletes')).toHaveLength(1);
        expect(within(dialog).getByText('Created, but kept for now')).toBeTruthy();
        expect(within(dialog).getByText(/would also delete everything inside it/)).toBeTruthy();
        expect(within(dialog).getByText('hand-made')).toBeTruthy();

        await user.click(within(dialog).getByRole('button', { name: 'Delete 1 resource' }));
        await user.click(within(dialog).getByRole('button', { name: 'Yes, delete 1 resource' }));

        await waitFor(() => expect(installed.welcome.exists).toBe(false));
        // What the dialog said it would keep is still there, untouched.
        expect(installed.category.exists).toBe(true);
        expect(handMade.parentId).toBe(installed.category.id);
        expect(installed.discord.writesTo(installed.category)).toEqual([]);
        expect(installed.discord.writesTo(handMade)).toEqual([]);

        // Half the journey is still bound, and the row says which half is missing.
        await user.click(within(dialog).getByRole('button', { name: 'Done' }));
        expect(await within(await flowRow(FLOW_NAME)).findByText('1/2 installed')).toBeTruthy();
    });
});
