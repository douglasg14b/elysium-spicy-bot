import { screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import type { Guild, GuildChannel, TicketCategoryView, TicketingConfigView, TicketTypeView } from '@brattybot/web-sdk';
import { installFakeApi } from '../../__tests__/support/fakeApi';
import { renderWithProviders } from '../../__tests__/support/renderWithProviders';
import { GuildProvider } from '../../guilds/GuildContext';
import { TicketsConfigPage } from '../TicketsConfigPage';

/**
 * A ticket type's own categories, picked in its dialog: what the dialog starts from, and
 * the slots it sends — only the changed ones: a new pick, and `null` for "the
 * server's".
 */

const GUILD: Guild = { id: 'guild-1', name: 'The Dungeon', iconURL: null, memberCount: 42 };
const CONFIG_PATH = `/api/guilds/${GUILD.id}/config/tickets`;

function category(id: string, name: string): GuildChannel {
    return { id, name, type: 'category', parentId: null, parentName: null, owner: null };
}

const SERVER_OPEN = category('100000000000000001', 'Tickets');
const SERVER_CLAIMED = category('100000000000000002', 'Claimed');
const SERVER_CLOSED = category('100000000000000003', 'Closed Tickets');
const VERIFY_OPEN = category('100000000000000004', 'Verification');
const VERIFY_CLAIMED = category('100000000000000005', 'Verify Claimed');

function view(channel: GuildChannel): TicketCategoryView {
    return { name: channel.name, discordId: channel.id, provenance: 'adopted', liveName: channel.name };
}

const VERIFICATION: TicketTypeView = {
    type: 'verification',
    label: 'Verification',
    nameTemplate: 'V{{####}}-{{subject}}',
    permissions: {
        subject: { view: true, send: true, readHistory: true, manageMessages: false },
        opener: { view: true, send: true, readHistory: true, manageMessages: false },
        staff: { view: true, send: true, readHistory: true, manageMessages: true },
    },
    autoClaimOnOpen: false,
    categories: { open: view(VERIFY_OPEN), claimed: null, closed: view(SERVER_CLOSED) },
};

const CONFIG: TicketingConfigView = {
    configured: true,
    deployed: true,
    categories: { open: view(SERVER_OPEN), claimed: view(SERVER_CLAIMED), closed: view(SERVER_CLOSED) },
    moderationRoleIds: ['200000000000000001'],
    moderationRoles: [{ id: '200000000000000001', name: 'Moderators' }],
    types: [VERIFICATION],
};

describe("a ticket type's own categories", () => {
    it('starts from what the type has, and sends only the slots changed', async () => {
        const api = installFakeApi();
        api.on('GET', '/api/guilds', () => ({ body: { guilds: [GUILD] } }));
        api.on('GET', CONFIG_PATH, () => ({ body: CONFIG }));
        api.on('GET', `/api/guilds/${GUILD.id}/roles`, () => ({
            body: { roles: [{ id: '200000000000000001', name: 'Moderators', color: 0, position: 1, owner: null }] },
        }));
        api.on('GET', `/api/guilds/${GUILD.id}/channels`, () => ({
            body: { channels: [SERVER_OPEN, SERVER_CLAIMED, SERVER_CLOSED, VERIFY_OPEN, VERIFY_CLAIMED] },
        }));
        api.on('PUT', `${CONFIG_PATH}/types/verification`, () => ({ body: CONFIG }));
        const { user } = renderWithProviders(
            <MemoryRouter>
                <GuildProvider>
                    <TicketsConfigPage />
                </GuildProvider>
            </MemoryRouter>
        );

        // Only the slots it has its own for are named in the table.
        expect(await screen.findByText('Own: Open tickets, Closed tickets')).toBeTruthy();
        await user.click(screen.getByRole('button', { name: 'Edit Verification' }));
        const dialog = within(await screen.findByRole('dialog'));

        // A slot it leaves to the server says which category that is.
        const claimed = dialog.getByRole('textbox', { name: 'Claimed tickets' }) as HTMLInputElement;
        expect(claimed.value).toBe('Server default — Claimed');
        expect((dialog.getByRole('textbox', { name: 'Open tickets' }) as HTMLInputElement).value).toBe('Verification');

        // Claimed gets its own; closed goes back to the server's.
        await user.click(claimed);
        await user.click(await screen.findByRole('option', { name: 'Verify Claimed' }));
        await user.click(dialog.getByRole('textbox', { name: 'Closed tickets' }));
        await user.click(await screen.findByRole('option', { name: 'Server default — Closed Tickets' }));
        await user.click(dialog.getByRole('button', { name: 'Save type' }));

        await waitFor(() => expect(api.requests.some((request) => request.method === 'PUT')).toBe(true));
        const saved = api.requests.find((request) => request.method === 'PUT');
        expect(saved?.body).toMatchObject({
            label: 'Verification',
            categories: { claimed: { discordId: VERIFY_CLAIMED.id }, closed: null },
        });
        // Only what changed: the kept open category is not re-sent.
        expect((saved?.body as { categories: object }).categories).not.toHaveProperty('open');
    });
});
