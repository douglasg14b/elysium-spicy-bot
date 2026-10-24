import { screen, waitFor } from '@testing-library/react';
import type { Guild } from '@brattybot/web-sdk';
import { createMemoryRouter, Outlet, RouterProvider, useBlocker } from 'react-router-dom';
import { beforeEach, describe, expect, it } from 'vitest';
import { App } from '../../App';
import { installFakeApi, type FakeApi } from '../../__tests__/support/fakeApi';
import { renderWithProviders } from '../../__tests__/support/renderWithProviders';
import { GuildProvider, SELECTED_GUILD_STORAGE_KEY, useGuilds } from '../GuildContext';
import { pathAfterGuildSwitch, useGuildSwitch } from '../useGuildSwitch';

/**
 * The server menu, as the whole app lives it: the dashboard works on one server at a time,
 * the operator picks which, and the pick survives a reload.
 */

const BRAT_PALACE: Guild = { id: '900000000000000001', name: 'Brat Palace', iconURL: null, memberCount: 3 };
const DUNGEON: Guild = { id: '900000000000000002', name: 'The Dungeon', iconURL: null, memberCount: 7 };

/** The shell, and everything the warnings page asks for, for each of `guilds`. */
function serveWarningsPage(guilds: readonly Guild[]): FakeApi {
    const api = installFakeApi();
    api.on('GET', '/api/bot', () => ({
        body: { ready: true, id: '300000000000000003', username: 'BrattyBot', flavour: 'production' },
    }));
    api.on('GET', '/api/auth/me', () => ({ body: { id: '200000000000000002', username: 'switch_witch', avatar: null } }));
    api.on('GET', '/api/guilds', () => ({ body: { guilds } }));
    for (const guild of guilds) {
        api.on('GET', `/api/guilds/${guild.id}/channels`, () => ({ body: { channels: [] } }));
        api.on('GET', `/api/guilds/${guild.id}/config/warnings`, () => ({
            body: { modChannelId: null, modChannelName: null },
        }));
    }
    return api;
}

function renderDashboardAt(path: string) {
    const router = createMemoryRouter([{ path: '*', element: <App /> }], { initialEntries: [path] });
    return { ...renderWithProviders(<RouterProvider router={router} />), router };
}

const warningsConfigRequested = (api: FakeApi, guild: Guild): boolean =>
    api.requests.some((request) => request.path === `/api/guilds/${guild.id}/config/warnings`);

beforeEach(() => {
    window.localStorage.clear();
});

describe('switching servers', () => {
    it('loads the picked server, and remembers the pick', async () => {
        const api = serveWarningsPage([BRAT_PALACE, DUNGEON]);
        const { user, router } = renderDashboardAt('/warnings');

        await user.click(await screen.findByRole('button', { name: /Switch server/ }));
        // The item's name starts with its monogram avatar's letters.
        await user.click(await screen.findByRole('menuitem', { name: new RegExp(`${DUNGEON.name}$`) }));

        await screen.findByRole('button', { name: `Server: ${DUNGEON.name}. Switch server` });
        await waitFor(() => expect(warningsConfigRequested(api, DUNGEON)).toBe(true));
        expect(router.state.location.pathname).toBe('/warnings');
        expect(router.state.location.state).toBeNull();
        expect(window.localStorage.getItem(SELECTED_GUILD_STORAGE_KEY)).toBe(DUNGEON.id);
    });

    it('opens on the remembered server after a reload', async () => {
        window.localStorage.setItem(SELECTED_GUILD_STORAGE_KEY, DUNGEON.id);
        const api = serveWarningsPage([BRAT_PALACE, DUNGEON]);
        renderDashboardAt('/warnings');

        await screen.findByRole('button', { name: `Server: ${DUNGEON.name}. Switch server` });
        await waitFor(() => expect(warningsConfigRequested(api, DUNGEON)).toBe(true));
        expect(warningsConfigRequested(api, BRAT_PALACE)).toBe(false);
    });

    it('falls back to the first server when the remembered one is no longer in the list', async () => {
        window.localStorage.setItem(SELECTED_GUILD_STORAGE_KEY, '900000000000000099');
        serveWarningsPage([BRAT_PALACE, DUNGEON]);
        renderDashboardAt('/warnings');

        await screen.findByRole('button', { name: `Server: ${BRAT_PALACE.name}. Switch server` });
    });

    it('offers no menu when there is only one server to work on', async () => {
        const api = serveWarningsPage([BRAT_PALACE]);
        renderDashboardAt('/warnings');

        await waitFor(() => expect(warningsConfigRequested(api, BRAT_PALACE)).toBe(true));
        expect((await screen.findAllByText(BRAT_PALACE.name)).length).toBeGreaterThan(0);
        expect(screen.queryByRole('button', { name: /Switch server/ })).toBeNull();
    });
});

describe('a switch away from unsaved work', () => {
    /** A page holding every navigation away, as the flow builder does with unsaved changes. */
    function UnsavedPage() {
        const blocker = useBlocker(({ currentLocation, nextLocation }) => currentLocation.pathname !== nextLocation.pathname);
        return blocker.state === 'blocked' ? (
            <button type="button" onClick={() => blocker.reset()}>
                Stay
            </button>
        ) : null;
    }

    function Shell() {
        const { selected } = useGuilds();
        const { switching, switchTo } = useGuildSwitch();
        return (
            <>
                <p>Working on {selected?.name ?? 'nothing'}</p>
                <button type="button" onClick={() => switchTo(DUNGEON.id)}>
                    Switch
                </button>
                {!switching && <Outlet />}
            </>
        );
    }

    it('keeps the server when the operator stays', async () => {
        serveWarningsPage([BRAT_PALACE, DUNGEON]);
        const router = createMemoryRouter(
            [
                {
                    element: (
                        <GuildProvider>
                            <Shell />
                        </GuildProvider>
                    ),
                    children: [
                        { path: '/flows/:flowId', element: <UnsavedPage /> },
                        { path: '/flows', element: null },
                    ],
                },
            ],
            { initialEntries: ['/flows/abc'] }
        );
        const { user } = renderWithProviders(<RouterProvider router={router} />);

        await screen.findByText(`Working on ${BRAT_PALACE.name}`);
        await user.click(screen.getByRole('button', { name: 'Switch' }));
        await user.click(await screen.findByRole('button', { name: 'Stay' }));

        expect(router.state.location.pathname).toBe('/flows/abc');
        expect(screen.getByText(`Working on ${BRAT_PALACE.name}`)).toBeDefined();
        expect(window.localStorage.getItem(SELECTED_GUILD_STORAGE_KEY)).toBeNull();
    });
});

describe('pathAfterGuildSwitch', () => {
    it("leaves a detail page, which names something in the old server, for its section's page", () => {
        expect(pathAfterGuildSwitch('/flows/abc')).toBe('/flows');
        expect(pathAfterGuildSwitch('/tickets/config')).toBe('/tickets');
        expect(pathAfterGuildSwitch('/warnings')).toBe('/warnings');
        expect(pathAfterGuildSwitch('/')).toBe('/');
    });
});
