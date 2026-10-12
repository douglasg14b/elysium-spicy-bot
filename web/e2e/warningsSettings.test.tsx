import { screen } from '@testing-library/react';
import type { PermissionsString } from 'discord.js';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { TestDiscord } from '../../src/shared/__tests__/support/testDiscord';
import { createSeedApi } from './preview/scenario/seedApi';
import { bootBotForDashboard } from './support/bootBot';
import { buildDashboardApp } from './support/dashboardApp';
import { installDashboardApi } from './support/dashboardApi';
import { renderDashboard } from './support/renderDashboard';

/**
 * Picking the warnings mod-log channel, end to end: the generated SDK against the real
 * route, which checks the channel against the guild the route resolved — that the bot can
 * see it, post in it and embed there — before storing it.
 */

const OPERATOR = { id: '100000000000000009', username: 'e2e-operator' };
/** What `validateWarningsModChannel` needs the bot to hold in the channel. */
const BOT_PERMISSIONS: readonly PermissionsString[] = ['ViewChannel', 'SendMessages', 'EmbedLinks'];

const running: TestDiscord[] = [];

beforeAll(async () => {
    await bootBotForDashboard();
});

afterEach(async () => {
    for (const discord of running.splice(0)) await discord.destroy();
});

describe('the warnings settings page', () => {
    it('saves a mod-log channel through the real route', async () => {
        const discord = new TestDiscord();
        running.push(discord);
        const guild = discord.createGuild({ bot: { permissions: BOT_PERMISSIONS } });
        const modLog = guild.createTextChannel({ name: 'naughty-list' });
        const client = await discord.start();
        const faults: string[] = [];
        installDashboardApi(client, OPERATOR);
        const { user } = renderDashboard('/warnings');

        await user.click(await screen.findByRole('textbox', { name: 'Mod Log Channel' }));
        await user.click(await screen.findByRole('option', { name: '#naughty-list' }));
        await user.click(screen.getByRole('button', { name: 'Save changes' }));

        expect(await screen.findByText('Warning notices now land in # naughty-list.')).toBeTruthy();

        // Stored, as the route reads it back rather than as the page remembers it.
        const seed = createSeedApi(
            buildDashboardApp({ client, operator: OPERATOR, onFault: (fault) => faults.push(fault) }),
            discord
        );
        const saved = await seed.send<{ modChannelId: string | null }>('GET', `/api/guilds/${guild.id}/config/warnings`);
        expect(saved.modChannelId).toBe(modLog.id);
        expect(faults).toEqual([]);
    });
});
