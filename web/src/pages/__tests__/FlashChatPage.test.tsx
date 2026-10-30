import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { installFakeApi, type FakeApi } from '../../__tests__/support/fakeApi';
import { renderWithProviders } from '../../__tests__/support/renderWithProviders';
import { GuildProvider } from '../../guilds/GuildContext';
import { FlashChatPage } from '../FlashChatPage';

/**
 * The flash chat page, driven through the fake API so the generated client, its zod and
 * the query cache all run as they do in the browser.
 */

const GUILD_ID = '900000000000000001';
const LIST_PATH = `/api/guilds/${GUILD_ID}/flash-chat`;
const LOBBY = '100000000000000001';
const CONFESSIONS = '100000000000000002';
const NUDES = '100000000000000003';
const GONE = '100000000000000004';

function channelRow(channelId: string, channelName: string | null, overrides: Record<string, unknown> = {}) {
    return {
        channelId,
        channelName,
        timeoutSeconds: 7_200,
        preservePinned: true,
        preserveHistory: true,
        running: true,
        updatedByName: 'mod',
        updatedAt: '2026-10-29T12:00:00.000Z',
        ...overrides,
    };
}

function serveGuild(api: FakeApi, channels: readonly unknown[]): void {
    api.on('GET', '/api/guilds', () => ({
        body: { guilds: [{ id: GUILD_ID, name: 'Brat Palace', iconURL: null, memberCount: 3 }] },
    }));
    api.on('GET', `/api/guilds/${GUILD_ID}/channels`, () => ({
        body: {
            channels: [
                { id: LOBBY, name: 'lobby', type: 'text', parentId: null, parentName: null },
                { id: CONFESSIONS, name: 'confessions', type: 'text', parentId: null, parentName: null },
                { id: NUDES, name: 'nudes', type: 'text', parentId: null, parentName: null },
            ],
        },
    }));
    api.on('GET', LIST_PATH, () => ({ body: { channels } }));
}

function renderPage() {
    return renderWithProviders(
        <GuildProvider>
            <FlashChatPage />
        </GuildProvider>
    );
}

type User = ReturnType<typeof renderPage>['user'];

async function setTimer(user: User, amount: string, unit: string): Promise<void> {
    const amountInput = screen.getByRole('textbox', { name: 'Delete messages after' });
    await user.clear(amountInput);
    await user.type(amountInput, amount);
    await user.click(screen.getByRole('textbox', { name: 'Unit' }));
    await user.click(screen.getByRole('option', { name: unit }));
}

describe('FlashChatPage', () => {
    it('turns flash chat on in a new channel, offering only channels it is not already on in', async () => {
        const api = installFakeApi();
        serveGuild(api, [channelRow(NUDES, 'nudes')]);
        api.on('PUT', `${LIST_PATH}/${CONFESSIONS}`, ({ body }) => ({
            body: channelRow(CONFESSIONS, 'confessions', body as Record<string, unknown>),
        }));
        const { user } = renderPage();

        await user.click(await screen.findByRole('button', { name: 'Add channel' }));
        await user.click(screen.getByRole('textbox', { name: 'Channel' }));
        expect(screen.queryByRole('option', { name: '#nudes' })).toBeNull();
        await user.click(screen.getByRole('option', { name: '#confessions' }));
        await setTimer(user, '5', 'minutes');
        await user.click(screen.getByRole('button', { name: 'Turn on' }));

        expect(await screen.findByText('Messages in #confessions now self-destruct after 5 minutes.')).toBeTruthy();
        // Keeping what is already there is the default: nobody wipes a channel by not reading.
        expect(api.requests.find((request) => request.method === 'PUT')?.body).toEqual({
            timeoutSeconds: 300,
            preservePinned: true,
            preserveHistory: true,
        });
        expect(await screen.findByText('#confessions')).toBeTruthy();
        expect(screen.getByText('5 minutes')).toBeTruthy();
    });

    it('opens an existing channel at its saved timer and saves the change', async () => {
        const api = installFakeApi();
        serveGuild(api, [channelRow(NUDES, 'nudes')]);
        api.on('PUT', `${LIST_PATH}/${NUDES}`, ({ body }) => ({
            body: channelRow(NUDES, 'nudes', body as Record<string, unknown>),
        }));
        const { user } = renderPage();

        await user.click(await screen.findByRole('button', { name: 'Edit flash chat in #nudes' }));
        expect(screen.getByRole('textbox', { name: 'Delete messages after' })).toHaveProperty('value', '2');
        expect(screen.getByRole('textbox', { name: 'Unit' })).toHaveProperty('value', 'hours');
        await setTimer(user, '1', 'days');
        await user.click(screen.getByRole('checkbox', { name: 'Keep pinned messages' }));
        await user.click(screen.getByRole('button', { name: 'Save changes' }));

        expect(await screen.findByText('#nudes now keeps messages for 1 day.')).toBeTruthy();
        expect(api.requests.find((request) => request.method === 'PUT')?.body).toEqual({
            timeoutSeconds: 86_400,
            preservePinned: false,
            preserveHistory: true,
        });
    });

    it("refuses a timer past fourteen days in the server's words, before sending anything", async () => {
        const api = installFakeApi();
        serveGuild(api, [channelRow(NUDES, 'nudes')]);
        const { user } = renderPage();

        await user.click(await screen.findByRole('button', { name: 'Edit flash chat in #nudes' }));
        await setTimer(user, '15', 'days');

        expect(screen.getByText('Fourteen days is the longest a message can wait to die.')).toBeTruthy();
        expect(screen.getByRole('button', { name: 'Save changes' })).toHaveProperty('disabled', true);
        expect(api.requests.some((request) => request.method === 'PUT')).toBe(false);
    });

    it("shows the server's own sentence when a save is refused", async () => {
        const api = installFakeApi();
        serveGuild(api, []);
        api.on('PUT', `${LIST_PATH}/${LOBBY}`, () => ({
            status: 400,
            body: { error: "I'm missing these permissions in #lobby: Manage Messages." },
        }));
        const { user } = renderPage();

        await user.click(await screen.findByRole('button', { name: 'Add channel' }));
        await user.click(screen.getByRole('textbox', { name: 'Channel' }));
        await user.click(screen.getByRole('option', { name: '#lobby' }));
        await user.click(screen.getByRole('button', { name: 'Turn on' }));

        expect(await screen.findByText("I'm missing these permissions in #lobby: Manage Messages.")).toBeTruthy();
    });

    it('turns a channel off after asking, and drops it from the list', async () => {
        const api = installFakeApi();
        serveGuild(api, [channelRow(NUDES, 'nudes'), channelRow(LOBBY, 'lobby')]);
        api.on('DELETE', `${LIST_PATH}/${NUDES}`, () => ({ status: 204 }));
        const { user } = renderPage();

        await user.click(await screen.findByRole('button', { name: 'Turn off flash chat in #nudes' }));
        const dialog = await screen.findByRole('dialog', { name: 'Turn off flash chat' });
        await user.click(within(dialog).getByRole('button', { name: 'Turn off' }));

        await waitFor(() => expect(screen.queryByText('#nudes')).toBeNull());
        expect(screen.getByText('#lobby')).toBeTruthy();
        expect(api.requests.filter((request) => request.method === 'DELETE')).toHaveLength(1);
    });

    it('marks only the broken rows: a channel Discord deleted, and one that is not running', async () => {
        const api = installFakeApi();
        serveGuild(api, [
            channelRow(NUDES, 'nudes'),
            channelRow(LOBBY, 'lobby', { running: false }),
            channelRow(GONE, null, { running: false }),
        ]);
        renderPage();

        expect(await screen.findByText('Channel gone')).toBeTruthy();
        expect(screen.getAllByText('Not running')).toHaveLength(1);
        // A deleted channel can only be turned off: there is nowhere left to save it to.
        expect(screen.queryByRole('button', { name: 'Edit flash chat in deleted channel' })).toBeNull();
        expect(screen.getByRole('button', { name: 'Turn off flash chat in deleted channel' })).toBeTruthy();
    });
});
