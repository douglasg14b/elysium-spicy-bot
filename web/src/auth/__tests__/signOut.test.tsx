import { screen, within } from '@testing-library/react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { listGuildsQueryKey } from '@brattybot/web-sdk';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { App } from '../../App';
import { installFakeApi, type FakeApi } from '../../__tests__/support/fakeApi';
import { renderWithProviders } from '../../__tests__/support/renderWithProviders';

/**
 * Signing out, both ways it happens: the operator asks to, or the API answers 401 because
 * the session is gone. Either way the dashboard lands on the login page, and the query cache
 * is emptied so nothing one person loaded is on hand for whoever signs in next in this tab.
 *
 * The whole app, through the fake API and the real `setupClient` wiring (`setupDom.ts` hands
 * it `onUnauthorized` exactly as `main.tsx` does).
 */

const GUILD_ID = '900000000000000001';
const OPERATOR = { id: '200000000000000002', username: 'switch_witch', avatar: null };

/** Everything the shell asks for before a page: the bot, the session, the guild list. */
function serveShell(api: FakeApi): void {
    api.on('GET', '/api/bot', () => ({
        body: { ready: true, id: '300000000000000003', username: 'BrattyBot', flavour: 'production' },
    }));
    api.on('GET', '/api/auth/me', () => ({ body: OPERATOR }));
    api.on('GET', '/api/guilds', () => ({
        body: { guilds: [{ id: GUILD_ID, name: 'Brat Palace', iconURL: null, memberCount: 3 }] },
    }));
    api.on('GET', `/api/guilds/${GUILD_ID}/channels`, () => ({ body: { channels: [] } }));
}

/** Hands the render's query cache out, so a test can see what is left in it. */
function CacheProbe({ onClient }: { readonly onClient: (client: QueryClient) => void }) {
    onClient(useQueryClient());
    return null;
}

/** The dashboard at `/warnings`, and the cache it runs on. */
function renderDashboardAt(): { readonly cache: () => QueryClient; readonly user: ReturnType<typeof renderWithProviders>['user'] } {
    let client: QueryClient | null = null;
    const router = createMemoryRouter([{ path: '*', element: <App /> }], { initialEntries: ['/warnings'] });
    const { user } = renderWithProviders(
        <>
            <CacheProbe onClient={(found) => (client = found)} />
            <RouterProvider router={router} />
        </>
    );
    return {
        user,
        cache: () => {
            if (!client) throw new Error('The cache probe never rendered.');
            return client;
        },
    };
}

describe('signing out', () => {
    it('lands on the login page when a page’s read answers 401, and forgets what was loaded', async () => {
        const api = installFakeApi();
        serveShell(api);
        // The session expired between the guild list and the page's own read.
        api.on('GET', `/api/guilds/${GUILD_ID}/config/warnings`, () => ({
            status: 401,
            body: { error: 'Not authenticated' },
        }));
        const { cache } = renderDashboardAt();

        expect(await screen.findByRole('link', { name: 'Log in with Discord' })).toBeTruthy();
        // Not the page's own error: the dashboard signed out instead.
        expect(screen.queryByText('Not authenticated')).toBeNull();
        expect(cache().getQueryData(listGuildsQueryKey())).toBeUndefined();
        // Asked once and left alone: nothing still mounted re-reads into another 401. Given a
        // moment first, since a re-read would come after the sign-out rather than before it.
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(api.requests.filter((request) => request.path.endsWith('/config/warnings'))).toHaveLength(1);
        expect(api.requests.filter((request) => request.path === '/api/guilds')).toHaveLength(1);
    });

    it('lands on the login page after Log out, and forgets what was loaded', async () => {
        const api = installFakeApi();
        serveShell(api);
        api.on('GET', `/api/guilds/${GUILD_ID}/config/warnings`, () => ({
            body: { modChannelId: null, modChannelName: null },
        }));
        api.on('POST', '/api/auth/logout', () => ({ body: { ok: true } }));
        const { user, cache } = renderDashboardAt();

        const header = await screen.findByRole('banner');
        await user.click(await within(header).findByText(OPERATOR.username));
        await user.click(await screen.findByRole('menuitem', { name: 'Log out' }));

        expect(await screen.findByRole('link', { name: 'Log in with Discord' })).toBeTruthy();
        expect(api.requests.some((request) => request.method === 'POST' && request.path === '/api/auth/logout')).toBe(true);
        expect(cache().getQueryData(listGuildsQueryKey())).toBeUndefined();
    });
});
