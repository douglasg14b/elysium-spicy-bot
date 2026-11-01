import { screen, waitFor, within } from '@testing-library/react';
import type { PermissionsString } from 'discord.js';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { TestDiscord } from '../../src/shared/__tests__/support/testDiscord';
import { createSeedApi } from './preview/scenario/seedApi';
import { bootBotForDashboard } from './support/bootBot';
import { buildDashboardApp } from './support/dashboardApp';
import { installDashboardApi } from './support/dashboardApi';
import { renderDashboard } from './support/renderDashboard';

/**
 * A warning's whole life from the dashboard, end to end: issued to a member found by name,
 * listed as active, edited, released with a reason, and then found under Released — through
 * the real warning routes, the real database and discord.js against TestDiscord, with each
 * step's mod-log notice landing in the channel.
 */

const OPERATOR_NAME = 'velvet_admin';
/** What `validateWarningsModChannel` needs, and what a notice needs to post. */
const BOT_PERMISSIONS: readonly PermissionsString[] = ['ViewChannel', 'SendMessages', 'EmbedLinks'];
const RULE = 'No means no';
const EDITED_RULE = 'No means NO';

const running: TestDiscord[] = [];

beforeAll(async () => {
    await bootBotForDashboard();
});

afterEach(async () => {
    for (const discord of running.splice(0)) await discord.destroy();
});

/** The table row holding `text`, once it is there. */
async function rowWith(text: string): Promise<HTMLElement> {
    const cell = await screen.findByText(text, { selector: 'td *' });
    const row = cell.closest('tr');
    if (!row) throw new Error(`"${text}" is not inside a table row.`);
    return row;
}

describe('a warning from the dashboard', () => {
    it('is issued, listed as active, edited, released with a reason, and listed as released', async () => {
        const discord = new TestDiscord();
        running.push(discord);
        const guild = discord.createGuild({ bot: { permissions: BOT_PERMISSIONS } });
        const operatorMember = guild.createMember({ username: OPERATOR_NAME });
        guild.createMember({ username: 'kitten_irl' });
        guild.createMember({ username: 'rope_bunny' });
        const modLog = guild.createTextChannel({ name: 'naughty-list' });
        const client = await discord.start();
        const operator = { id: operatorMember.id, username: OPERATOR_NAME };
        const faults: string[] = [];
        const api = createSeedApi(buildDashboardApp({ client, operator, onFault: (fault) => faults.push(fault) }), discord);
        await api.send('PUT', `/api/guilds/${guild.id}/config/warnings`, { modChannelId: modLog.id });

        installDashboardApi(client, operator);
        const { user } = renderDashboard('/warnings');
        expect(await screen.findByText('No warnings yet')).toBeTruthy();

        // -- Issue, to a member found by name --
        await user.click(screen.getAllByRole('button', { name: 'Issue warning' })[0] as HTMLElement);
        const issueDialog = await screen.findByRole('dialog', { name: 'Issue a warning' });
        await user.type(within(issueDialog).getByRole('textbox', { name: 'Member' }), 'kit');
        await user.click(await screen.findByRole('option', { name: /kitten_irl/ }));
        await user.type(within(issueDialog).getByRole('textbox', { name: 'Rule' }), RULE);
        await user.type(within(issueDialog).getByRole('textbox', { name: 'Description' }), 'Kept going after the safeword.');
        await user.click(within(issueDialog).getByRole('button', { name: 'Issue warning' }));

        expect(await screen.findByText(/is on the record/)).toBeTruthy();
        expect(screen.queryByText(/^Saved, but/)).toBeNull();
        const activeRow = await rowWith(RULE);
        // The slug, as the row's open button names it.
        const slug = within(activeRow).getByRole('button', { name: /^Open / }).getAttribute('aria-label')?.slice('Open '.length) ?? '';
        expect(slug).toMatch(/^no-means-no-/);
        expect(within(activeRow).getByText('kitten_irl')).toBeTruthy();
        expect(within(activeRow).getByText(OPERATOR_NAME)).toBeTruthy();
        expect(modLog.messages).toHaveLength(1);

        // -- Edit, from the drawer --
        await user.click(activeRow);
        const drawer = await screen.findByRole('dialog', { name: new RegExp(slug) });
        await user.click(within(drawer).getByRole('button', { name: 'Edit' }));
        const editDialog = await screen.findByRole('dialog', { name: `Edit ${slug}` });
        const rule = within(editDialog).getByRole('textbox', { name: 'Rule' });
        await user.clear(rule);
        await user.type(rule, EDITED_RULE);
        await user.click(within(editDialog).getByRole('button', { name: 'Save changes' }));

        expect(await screen.findByText(new RegExp(`${slug} updated`))).toBeTruthy();
        await rowWith(EDITED_RULE);
        await waitFor(() => expect(within(drawer).getByText(EDITED_RULE)).toBeTruthy());
        expect(within(drawer).getByText('Last edited')).toBeTruthy();
        expect(modLog.messages).toHaveLength(2);

        // -- Release, with a reason --
        await user.click(within(drawer).getByRole('button', { name: 'Release' }));
        const releaseDialog = await screen.findByRole('dialog', { name: 'Release warning' });
        await user.type(within(releaseDialog).getByRole('textbox', { name: 'Reason' }), 'Grovelled beautifully.');
        await user.click(within(releaseDialog).getByRole('button', { name: 'Release warning' }));

        expect(await screen.findByText(new RegExp(`${slug} released`))).toBeTruthy();
        // Released, it leaves the active list — and the drawer with it.
        expect(await screen.findByText("Nobody's on thin ice")).toBeTruthy();
        expect(screen.queryByRole('dialog')).toBeNull();
        expect(modLog.messages).toHaveLength(3);

        // -- Found under Released, with its record --
        await user.click(screen.getByRole('radio', { name: 'Released' }));
        await rowWith(EDITED_RULE);
        // The drawer that closed when the warning left Active does not come back by itself.
        expect(screen.queryByRole('dialog')).toBeNull();
        await user.click(await rowWith(EDITED_RULE));
        const record = await screen.findByRole('dialog', { name: new RegExp(slug) });
        expect(within(record).getByText('Grovelled beautifully.')).toBeTruthy();
        expect(within(record).getByText('kitten_irl')).toBeTruthy();
        expect(within(record).queryByRole('button', { name: 'Edit' })).toBeNull();
        expect(faults).toEqual([]);
    });
});
