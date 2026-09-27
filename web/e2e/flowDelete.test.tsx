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
 * Deleting an installed flow from the flows list, end to end: the trash button opens the
 * inventory under a delete confirmation, the operator deletes the flow, and nothing in
 * Discord is touched.
 *
 * "Offer, never assume" is the rule under test. Deleting a flow leaves its channels and
 * roles where they are, so the dialog's job is to say what will be left behind and to
 * offer the cleanup as a separate action beside the delete. Whether that promise holds is
 * a property of the whole path — the dialog, the delete route, and every module the route
 * reaches — which is why this asserts on TestDiscord's request log and not just on the page:
 * a delete that quietly tidied up would render identically.
 */

const BOT_PERMISSIONS: readonly PermissionsString[] = ['ManageChannels', 'ManageRoles'];
const OPERATOR = { id: '100000000000000002', username: 'e2e-operator' };
const FLOW_NAME = 'Lobby greeter';

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

describe('deleting an installed flow from the flows list', () => {
    it('names what it leaves behind, deletes the flow, and sends Discord nothing', async () => {
        const installed = await guildWithInstalledFlow();
        // Everything from here on is the scenario; the install's own writes are behind this line.
        const requestsBeforeDelete = installed.discord.requests.length;
        installDashboardApi(installed.client, OPERATOR);
        const { user } = renderDashboard('/flows');

        const row = await flowRow(FLOW_NAME);
        await user.click(within(row).getByRole('button', { name: `Delete ${FLOW_NAME}` }));
        const dialog = await screen.findByRole('dialog', { name: `What ${FLOW_NAME} has in your server` });

        // The dialog says the flow goes and the server keeps its things, and names them.
        expect(
            within(dialog).getByText(
                /and its 0 nodes will be deleted for good\. Anything below stays in the server unless you remove it here first\./
            )
        ).toBeTruthy();
        expect(await within(dialog).findByText('#welcome')).toBeTruthy();
        expect(within(dialog).getByText('Lobby')).toBeTruthy();
        // The cleanup is offered beside the delete, not folded into it.
        expect(within(dialog).getByRole('button', { name: 'Delete 2 resources' })).toBeTruthy();

        await user.click(within(dialog).getByRole('button', { name: 'Delete flow' }));

        // The page's side: the flow is gone, and with it the only row.
        expect(await screen.findByText('No flows yet')).toBeTruthy();
        expect(screen.queryByRole('dialog', { name: `What ${FLOW_NAME} has in your server` })).toBeNull();

        // Discord's side: both channels still there, and the delete sent no write anywhere.
        await waitFor(() => expect(screen.queryByText(FLOW_NAME, { selector: 'td *' })).toBeNull());
        expect(installed.category.exists).toBe(true);
        expect(installed.welcome.exists).toBe(true);
        expect(installed.welcome.parentId).toBe(installed.category.id);
        const writesDuringScenario = installed.discord.requests
            .slice(requestsBeforeDelete)
            .filter((request) => request.method !== 'GET');
        expect(writesDuringScenario).toEqual([]);
    });
});
