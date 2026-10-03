import { screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { TestDiscord } from '../../src/shared/__tests__/support/testDiscord';
import { createSeedApi } from './preview/scenario/seedApi';
import { bootBotForDashboard } from './support/bootBot';
import { buildDashboardApp } from './support/dashboardApp';
import { installDashboardApi } from './support/dashboardApi';
import { renderDashboard } from './support/renderDashboard';

/**
 * Saving staff roles from the server settings page, end to end — the generated SDK
 * against the real guild routes.
 *
 * The dom tests prove the page against a fake API that answers whatever it is told. This
 * proves the two halves of the generated pipeline agree with each other: the paths the
 * spec gives the SDK are the paths the server mounts, the body it sends is one the
 * route's validator accepts, and the answer lands back in the page's cache.
 */

const OPERATOR = { id: '100000000000000002', username: 'e2e-operator' };

const running: TestDiscord[] = [];

beforeAll(async () => {
    await bootBotForDashboard();
});

afterEach(async () => {
    for (const discord of running.splice(0)) await discord.destroy();
});

describe('staff roles on the server settings page', () => {
    it('saves a picked role through the generated client and the real route', async () => {
        const discord = new TestDiscord();
        running.push(discord);
        const guild = discord.createGuild();
        const staff = guild.createRole({ name: 'Head Brat' });
        const client = await discord.start();
        installDashboardApi(client, OPERATOR);
        const { user } = renderDashboard('/settings');

        await user.click(await screen.findByRole('textbox', { name: 'Staff roles' }));
        await user.click(await screen.findByRole('option', { name: 'Head Brat' }));
        await user.click(screen.getByRole('button', { name: 'Save changes' }));

        expect(await screen.findByText('1 role now count as staff.')).toBeTruthy();
        await waitFor(() => expect(screen.getByRole('button', { name: 'Save changes' })).toHaveProperty('disabled', true));

        // Stored, as the route reads it back rather than as the page remembers it.
        const seed = createSeedApi(buildDashboardApp({ client, operator: OPERATOR, onFault: () => undefined }), discord);
        const saved = await seed.send<{ staffRoleIds: string[] }>('GET', `/api/guilds/${guild.id}/settings`);
        expect(saved.staffRoleIds).toEqual([staff.id]);
    });
});
