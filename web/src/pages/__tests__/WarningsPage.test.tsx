import { screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { installFakeApi, type FakeApi } from '../../__tests__/support/fakeApi';
import { renderWithProviders } from '../../__tests__/support/renderWithProviders';
import { GuildProvider } from '../../guilds/GuildContext';
import { WarningsPage } from '../WarningsPage';

/**
 * The warnings page, the first on the generated SDK: its config and channels arrive as
 * TanStack queries, the save is a mutation, and the cache — not a local copy — is what
 * the form compares its draft against afterwards.
 *
 * Driven through the fake API rather than a mocked SDK, so the generated client, the
 * `setupClient` interceptors and the query cache all run as they do in the browser.
 */

const GUILD_ID = '900000000000000001';
const CONFIG_PATH = `/api/guilds/${GUILD_ID}/config/warnings`;
const LOBBY = '100000000000000001';
const MOD_LOG = '100000000000000002';

function serveGuild(api: FakeApi, modChannelId: string | null): void {
    api.on('GET', '/api/guilds', () => ({
        body: { guilds: [{ id: GUILD_ID, name: 'Brat Palace', iconURL: null, memberCount: 3 }] },
    }));
    api.on('GET', `/api/guilds/${GUILD_ID}/channels`, () => ({
        body: {
            channels: [
                { id: LOBBY, name: 'lobby', type: 'text', parentId: null, parentName: null },
                { id: MOD_LOG, name: 'mod-log', type: 'text', parentId: null, parentName: null },
            ],
        },
    }));
    api.on('GET', CONFIG_PATH, () => ({
        body: { modChannelId, modChannelName: modChannelId === LOBBY ? 'lobby' : null },
    }));
}

function renderPage() {
    return renderWithProviders(
        <GuildProvider>
            <WarningsPage />
        </GuildProvider>
    );
}

async function pickChannel(user: ReturnType<typeof renderPage>['user'], name: string): Promise<void> {
    await user.click(await screen.findByRole('textbox', { name: 'Mod Log Channel' }));
    await user.click(screen.getByRole('option', { name }));
}

function saveButton(): HTMLElement {
    return screen.getByRole('button', { name: 'Save changes' });
}

describe('WarningsPage', () => {
    it('saves the picked channel and treats the answer as the new saved value', async () => {
        const api = installFakeApi();
        serveGuild(api, LOBBY);
        api.on('PUT', CONFIG_PATH, ({ body }) => ({
            body: { modChannelId: (body as { modChannelId: string }).modChannelId, modChannelName: 'mod-log' },
        }));
        const { user } = renderPage();

        await pickChannel(user, '#mod-log');
        await user.click(saveButton());

        expect(await screen.findByText('Warning notices now land in # mod-log.')).toBeTruthy();
        expect(api.requests.find((request) => request.method === 'PUT')?.body).toEqual({ modChannelId: MOD_LOG });
        /*
         * The draft is dropped on success, so the picker now shows the saved value — and
         * shows the new channel only if the answer went into the cache. Without it the
         * picker would fall back to `#lobby` and look as though the save never happened.
         */
        await waitFor(() => expect(saveButton()).toHaveProperty('disabled', true));
        expect(screen.getByRole('textbox', { name: 'Mod Log Channel' })).toHaveProperty('value', '#mod-log');
        expect(api.requests.filter((request) => request.path === CONFIG_PATH && request.method === 'GET')).toHaveLength(1);
    });

    it("shows the server's own sentence when a save is refused", async () => {
        const api = installFakeApi();
        serveGuild(api, LOBBY);
        api.on('PUT', CONFIG_PATH, () => ({ status: 400, body: { error: 'That channel is a ghost town.' } }));
        const { user } = renderPage();

        await pickChannel(user, '#mod-log');
        await user.click(saveButton());

        expect(await screen.findByText('That channel is a ghost town.')).toBeTruthy();
    });

    it("shows the server's sentence when the config cannot be loaded", async () => {
        const api = installFakeApi();
        serveGuild(api, LOBBY);
        api.on('GET', CONFIG_PATH, () => ({ status: 403, body: { error: 'You do not have access to this server.' } }));

        renderPage();

        expect(await screen.findByText('You do not have access to this server.')).toBeTruthy();
    });
});
