import { screen, waitFor, within } from '@testing-library/react';
import type { Client, PermissionsString } from 'discord.js';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { TestDiscord, type ServerChannel } from '../../src/shared/__tests__/support/testDiscord';
import { createSeedApi } from './preview/scenario/seedApi';
import { bootBotForDashboard } from './support/bootBot';
import { buildDashboardApp } from './support/dashboardApp';
import { installDashboardApi } from './support/dashboardApi';
import { renderDashboard } from './support/renderDashboard';

/**
 * The builder toolbar's install face against the real routes and TestDiscord: uninstalling
 * from the toolbar's inventory puts the toolbar back on offering an install.
 *
 * The toolbar reads the same published-state query as the inventory dialog, and nothing in
 * the builder asks again after a teardown — so the button changes only because the
 * dialog's own re-read moved the answer the two share.
 *
 * Deploying from the toolbar has no case here: `deployFlowButtons` finds the guild through
 * the `DISCORD_CLIENT` singleton, which the e2e app never logs in (see `dashboardApp.ts`),
 * so a deploy can only ever be refused in this harness.
 */

const BOT_PERMISSIONS: readonly PermissionsString[] = ['ManageChannels', 'ManageRoles'];
const OPERATOR = { id: '100000000000000007', username: 'e2e-operator' };
const FLOW_NAME = 'Velvet rope';

interface InstalledFlow {
    readonly discord: TestDiscord;
    readonly client: Client<true>;
    readonly flowId: string;
    readonly lounge: ServerChannel;
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
    return { discord, client, flowId: flow.flowId, lounge: guild.channel(loungeId) };
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
});
