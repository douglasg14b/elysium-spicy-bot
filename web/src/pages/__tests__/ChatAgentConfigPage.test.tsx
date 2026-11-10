import { screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { installFakeApi, type FakeApi } from '../../__tests__/support/fakeApi';
import { renderWithProviders } from '../../__tests__/support/renderWithProviders';
import { GuildProvider } from '../../guilds/GuildContext';
import { ChatAgentConfigPage } from '../ChatAgentConfigPage';

/** The chat agent page through the fake API, as `WarningsConfigPage.test.tsx` drives its page. */

const GUILD_ID = '900000000000000001';
const CONFIG_PATH = `/api/guilds/${GUILD_ID}/config/chat-agent`;
const RULES = '100000000000000001';
const KINK_101 = '100000000000000002';

const NO_TEXTS = { botRules: '', serverNotes: '' };

function serveGuild(
    api: FakeApi,
    contextChannels: readonly { channelId: string; isRules: boolean; channelName: string | null }[],
    texts: { botRules: string; serverNotes: string } = NO_TEXTS
) {
    api.on('GET', '/api/guilds', () => ({
        body: { guilds: [{ id: GUILD_ID, name: 'Brat Palace', iconURL: null, memberCount: 3 }] },
    }));
    api.on('GET', `/api/guilds/${GUILD_ID}/channels`, () => ({
        body: {
            channels: [
                { id: RULES, name: 'rules', type: 'text', parentId: null, parentName: null, owner: null },
                { id: KINK_101, name: 'kink-101', type: 'text', parentId: null, parentName: null, owner: null },
            ],
        },
    }));
    api.on('GET', CONFIG_PATH, () => ({ body: { contextChannels, ...texts } }));
}

function renderPage() {
    return renderWithProviders(
        <GuildProvider>
            <ChatAgentConfigPage />
        </GuildProvider>
    );
}

function saveButton(): HTMLElement {
    return screen.getByRole('button', { name: 'Save changes' });
}

describe('ChatAgentConfigPage', () => {
    it('adds a channel, marks the saved one as rules, and saves the whole list', async () => {
        const api = installFakeApi();
        serveGuild(api, [{ channelId: RULES, isRules: false, channelName: 'rules' }]);
        api.on('PUT', CONFIG_PATH, ({ body }) => ({
            body: {
                ...NO_TEXTS,
                contextChannels: (body as { contextChannels: { channelId: string; isRules: boolean }[] }).contextChannels.map(
                    (entry) => ({ ...entry, channelName: entry.channelId === RULES ? 'rules' : 'kink-101' })
                ),
            },
        }));
        const { user } = renderPage();

        await user.click(await screen.findByRole('checkbox', { name: '#rules is a rules channel' }));
        await user.click(screen.getByRole('textbox', { name: 'Add a channel' }));
        await user.click(screen.getByRole('option', { name: '#kink-101' }));
        await user.click(saveButton());

        expect(await screen.findByText('Chat agent config saved.')).toBeTruthy();
        expect(api.requests.find((request) => request.method === 'PUT')?.body).toEqual({
            contextChannels: [
                { channelId: RULES, isRules: true },
                { channelId: KINK_101, isRules: false },
            ],
            ...NO_TEXTS,
        });
        await waitFor(() => expect(saveButton()).toHaveProperty('disabled', true));
    });

    it('removes a channel', async () => {
        const api = installFakeApi();
        serveGuild(api, [{ channelId: RULES, isRules: true, channelName: 'rules' }]);
        api.on('PUT', CONFIG_PATH, () => ({ body: { contextChannels: [], ...NO_TEXTS } }));
        const { user } = renderPage();

        await user.click(await screen.findByRole('button', { name: 'Remove #rules' }));
        await user.click(saveButton());

        expect(await screen.findByText('Chat agent config saved.')).toBeTruthy();
        expect(api.requests.find((request) => request.method === 'PUT')?.body).toEqual({ contextChannels: [], ...NO_TEXTS });
    });

    it('edits the rules and notes beside the saved channels, and saves them all together', async () => {
        const api = installFakeApi();
        serveGuild(api, [{ channelId: RULES, isRules: true, channelName: 'rules' }], { botRules: 'Be nice-ish.', serverNotes: '' });
        api.on('PUT', CONFIG_PATH, ({ body }) => ({
            body: { ...(body as object), contextChannels: [{ channelId: RULES, isRules: true, channelName: 'rules' }] },
        }));
        const { user } = renderPage();

        const rules = await screen.findByRole('textbox', { name: 'Rules for the bot' });
        expect(rules).toHaveProperty('value', 'Be nice-ish.');
        expect(screen.getByText(/12 \/ 2,000/)).toBeTruthy();
        await user.clear(rules);
        await user.type(rules, 'Never name other servers.');
        await user.type(screen.getByRole('textbox', { name: 'Notes about the server' }), 'Munches monthly.');
        await user.click(saveButton());

        expect(await screen.findByText('Chat agent config saved.')).toBeTruthy();
        expect(api.requests.find((request) => request.method === 'PUT')?.body).toEqual({
            contextChannels: [{ channelId: RULES, isRules: true }],
            botRules: 'Never name other servers.',
            serverNotes: 'Munches monthly.',
        });
    });

    it("holds the save on notes over the limit, with the server's sentence under the box", async () => {
        const api = installFakeApi();
        serveGuild(api, [], { botRules: '', serverNotes: 'x'.repeat(2_000) });
        const { user } = renderPage();

        await user.type(await screen.findByRole('textbox', { name: 'Notes about the server' }), 'y');

        expect(screen.getByText('Keep the notes to 2,000 characters — I read them before every reply.')).toBeTruthy();
        expect(saveButton()).toHaveProperty('disabled', true);
        expect(api.requests.some((request) => request.method === 'PUT')).toBe(false);
    });

    it("shows the server's own sentence when a save is refused", async () => {
        const api = installFakeApi();
        serveGuild(api, []);
        api.on('PUT', CONFIG_PATH, () => ({
            status: 400,
            body: { error: "I can't read #kink-101. Give me View Channel and Read Message History there first." },
        }));
        const { user } = renderPage();

        await user.click(await screen.findByRole('textbox', { name: 'Add a channel' }));
        await user.click(screen.getByRole('option', { name: '#kink-101' }));
        await user.click(saveButton());

        expect(
            await screen.findByText("I can't read #kink-101. Give me View Channel and Read Message History there first.")
        ).toBeTruthy();
    });
});
