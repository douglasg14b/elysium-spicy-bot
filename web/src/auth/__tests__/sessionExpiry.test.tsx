import { screen, waitFor, within } from '@testing-library/react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { listGuildsQueryKey, updateWarningsConfig, type AuthUser } from '@brattybot/web-sdk';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { App } from '../../App';
import { JourneyDriftDialog } from '../../flows/JourneyDriftDialog';
import { installFakeApi, type FakeApi, type FakeApiHandler, type FakeApiMethod } from '../../__tests__/support/fakeApi';
import { renderWithProviders } from '../../__tests__/support/renderWithProviders';
import { onSessionLost, sessionBegan } from '../sessionGate';
import { startOver } from '../startOver';

vi.mock('../startOver', () => ({ startOver: vi.fn() }));

/**
 * The session, as the whole app lives it: signing in, a session that runs out mid-edit,
 * signing in again, and Log out.
 *
 * A session that runs out does not sign the dashboard out. The page stays as it was, the
 * "sign in again" panel goes over it, and the request that was refused waits; once the
 * same person is back it goes out again, and the page carries on. The whole app, through
 * the fake API and the real session gate (`setupDom.ts` hands `setupClient` the same
 * `fetch` `main.tsx` does).
 */

const GUILD_ID = '900000000000000001';
const OPERATOR: AuthUser = { id: '200000000000000002', username: 'switch_witch', avatar: null };
const SOMEBODY_ELSE: AuthUser = { id: '200000000000000003', username: 'brat_in_charge', avatar: null };
const CONFIG_PATH = `/api/guilds/${GUILD_ID}/config/warnings`;
const MOD_LOG = '100000000000000002';
const PANEL_TITLE = 'Your session safeworded out';
const NOT_AUTHENTICATED = { status: 401, body: { error: 'Not authenticated' } } as const;

/** A user-event session, as a render hands it out. */
type User = ReturnType<typeof renderWithProviders>['user'];

/** Long enough for anything already set going — a re-read, a notification — to have shown. */
const settleAMoment = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 100));

/** The server's side of the session: who the cookie belongs to, if anyone. */
interface FakeSession {
    user: AuthUser | null;
}

/** Answer `method path` while the session is live, and 401 as `requireAuth` does once it is not. */
function guarded(api: FakeApi, session: FakeSession, method: FakeApiMethod, path: string, handler: FakeApiHandler): void {
    api.on(method, path, (request) => (session.user ? handler(request) : NOT_AUTHENTICATED));
}

/** `/me`, answering for whoever the session belongs to — 401 when it belongs to nobody. */
function serveMe(api: FakeApi, session: FakeSession): void {
    api.on('GET', '/api/auth/me', () => (session.user ? { body: session.user } : NOT_AUTHENTICATED));
}

/** Everything the warnings page asks for, the shell first: the bot, the session, the guild list. */
function serveWarningsPage(api: FakeApi, session: FakeSession): void {
    api.on('GET', '/api/bot', () => ({
        body: { ready: true, id: '300000000000000003', username: 'BrattyBot', flavour: 'production' },
    }));
    serveMe(api, session);
    guarded(api, session, 'GET', '/api/guilds', () => ({
        body: { guilds: [{ id: GUILD_ID, name: 'Brat Palace', iconURL: null, memberCount: 3 }] },
    }));
    guarded(api, session, 'GET', `/api/guilds/${GUILD_ID}/channels`, () => ({
        body: { channels: [{ id: MOD_LOG, name: 'mod-log', type: 'text', parentId: null, parentName: null }] },
    }));
    guarded(api, session, 'GET', CONFIG_PATH, () => ({ body: { modChannelId: null, modChannelName: null } }));
    guarded(api, session, 'PUT', CONFIG_PATH, () => ({ body: { modChannelId: MOD_LOG, modChannelName: 'mod-log' } }));
}

/** Hands the render's query cache out, so a test can see what is left in it. */
function CacheProbe({ onClient }: { readonly onClient: (client: QueryClient) => void }) {
    onClient(useQueryClient());
    return null;
}

/** The dashboard at `/warnings`, and the cache it runs on. */
function renderDashboardAt(): { readonly cache: () => QueryClient; readonly user: User } {
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

const requestsTo = (api: FakeApi, method: FakeApiMethod, path: string) =>
    api.requests.filter((request) => request.method === method && request.path === path);

/** The warnings page loaded, `#mod-log` picked but not saved, and the session gone. */
async function pickThenLoseSession(): Promise<{
    readonly api: FakeApi;
    readonly session: FakeSession;
    readonly cache: () => QueryClient;
    readonly user: User;
}> {
    const api = installFakeApi();
    const session: FakeSession = { user: OPERATOR };
    serveWarningsPage(api, session);
    const { user, cache } = renderDashboardAt();

    await user.click(await screen.findByRole('textbox', { name: 'Mod Log Channel' }));
    await user.click(screen.getByRole('option', { name: '#mod-log' }));
    session.user = null;
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await screen.findByRole('dialog', { name: PANEL_TITLE });
    return { api, session, cache, user };
}

describe('a session that runs out', () => {
    it('holds a refused Save under the panel, keeps the pick, and saves it once the same person is back', async () => {
        const { api, session, cache, user } = await pickThenLoseSession();

        // The page is as it was, with nothing said about a failure — the Save is waiting,
        // not failed — and what was loaded is still loaded.
        expect(screen.queryByText("Couldn't save")).toBeNull();
        expect(screen.getByRole('textbox', { name: 'Mod Log Channel' })).toHaveProperty('value', '#mod-log');
        expect(cache().getQueryData(listGuildsQueryKey())).toBeDefined();
        expect(requestsTo(api, 'PUT', CONFIG_PATH)).toHaveLength(1);

        session.user = OPERATOR;
        await user.click(screen.getByRole('button', { name: "I've signed in" }));

        expect(await screen.findByText('Warning notices now land in # mod-log.')).toBeTruthy();
        await waitFor(() => expect(screen.queryByRole('dialog', { name: PANEL_TITLE })).toBeNull());
        const puts = requestsTo(api, 'PUT', CONFIG_PATH);
        expect(puts).toHaveLength(2);
        expect(puts[1]?.body).toEqual({ modChannelId: MOD_LOG });
    });

    it('holds a refused read without "Could not load servers", and fills the page in once the same person is back', async () => {
        const api = installFakeApi();
        const session: FakeSession = { user: OPERATOR };
        serveWarningsPage(api, session);
        // The session runs out the moment the boot `/me` has answered.
        api.on('GET', '/api/auth/me', () => {
            const signedIn = session.user;
            session.user = null;
            return signedIn ? { body: signedIn } : NOT_AUTHENTICATED;
        });
        const { user } = renderDashboardAt();

        await screen.findByRole('dialog', { name: PANEL_TITLE });
        // Neither a notification nor a re-read comes after the panel.
        await settleAMoment();
        expect(screen.queryByText('Could not load servers')).toBeNull();
        expect(requestsTo(api, 'GET', '/api/guilds')).toHaveLength(1);

        session.user = OPERATOR;
        serveMe(api, session);
        await user.click(screen.getByRole('button', { name: "I've signed in" }));

        expect(await screen.findByRole('textbox', { name: 'Mod Log Channel' })).toBeTruthy();
        expect(screen.queryByRole('dialog', { name: PANEL_TITLE })).toBeNull();
        expect(requestsTo(api, 'GET', '/api/guilds')).toHaveLength(2);
    });

    it('keeps the panel up, and says why, when asked before the sign-in has finished', async () => {
        const { user } = await pickThenLoseSession();

        await user.click(screen.getByRole('button', { name: "I've signed in" }));

        expect(await screen.findByText('Nice try. Still no session — finish signing in on the other tab first.')).toBeTruthy();
        expect(screen.getByRole('dialog', { name: PANEL_TITLE })).toBeTruthy();
    });

    it('sends the operator to Discord in a new tab, leaving this one as it is', async () => {
        await pickThenLoseSession();

        const signIn = within(screen.getByRole('dialog', { name: PANEL_TITLE })).getByRole('link', { name: 'Sign in again' });

        expect(signIn.getAttribute('href')).toBe('/api/auth/login');
        expect(signIn.getAttribute('target')).toBe('_blank');
    });

    it('checks by itself when the operator comes back to the window', async () => {
        const { session } = await pickThenLoseSession();

        session.user = OPERATOR;
        window.dispatchEvent(new Event('focus'));

        expect(await screen.findByText('Warning notices now land in # mod-log.')).toBeTruthy();
        expect(screen.queryByRole('dialog', { name: PANEL_TITLE })).toBeNull();
    });

    it('loads the dashboard afresh when somebody else signs in, and sends nothing of the last person’s', async () => {
        onTestFinished(() => {
            vi.mocked(startOver).mockClear();
        });
        const { api, session, user } = await pickThenLoseSession();

        // They signed in on another tab, so the cookie is theirs now. A write that fires
        // under the panel before anyone asks — an autosave's debounce running out — would
        // go out as them if it were sent; it waits instead.
        session.user = SOMEBODY_ELSE;
        void updateWarningsConfig({ path: { guildId: GUILD_ID }, body: { modChannelId: MOD_LOG } });
        await user.click(screen.getByRole('button', { name: "I've signed in" }));

        await waitFor(() => expect(startOver).toHaveBeenCalledOnce());
        // The page under the panel is gone, and neither held write was sent as them.
        expect(screen.queryByRole('dialog', { name: PANEL_TITLE })).toBeNull();
        expect(screen.queryByRole('textbox', { name: 'Mod Log Channel' })).toBeNull();
        await settleAMoment();
        expect(requestsTo(api, 'PUT', CONFIG_PATH)).toHaveLength(1);
    });

    it('is the login page on a first visit with no session at all', async () => {
        const api = installFakeApi();
        serveWarningsPage(api, { user: null });

        renderDashboardAt();

        expect(await screen.findByRole('link', { name: 'Log in with Discord' })).toBeTruthy();
        expect(screen.queryByRole('dialog', { name: PANEL_TITLE })).toBeNull();
    });

    it('hears a 401 from a journey call too', async () => {
        // A guard against a call that bypasses the SDK: the journey dialogs once went
        // through a hand-written client, which a session gate on the SDK would not see.
        const api = installFakeApi();
        api.on('GET', `/api/guilds/${GUILD_ID}/journeys/onboarding/drift`, () => NOT_AUTHENTICATED);
        const lost = vi.fn();
        onTestFinished(onSessionLost(lost));
        sessionBegan();

        renderWithProviders(
            <JourneyDriftDialog
                opened
                onClose={() => undefined}
                guildId={GUILD_ID}
                journeyKey="onboarding"
                journeyName="Onboarding"
                subject="journey"
            />
        );

        await waitFor(() => expect(lost).toHaveBeenCalledTimes(1));
    });
});

describe('Log out', () => {
    it('lands on the login page and forgets what was loaded', async () => {
        const api = installFakeApi();
        serveWarningsPage(api, { user: OPERATOR });
        api.on('POST', '/api/auth/logout', () => ({ body: { ok: true } }));
        const { user, cache } = renderDashboardAt();

        const header = await screen.findByRole('banner');
        await user.click(await within(header).findByText(OPERATOR.username));
        await user.click(await screen.findByRole('menuitem', { name: 'Log out' }));

        expect(await screen.findByRole('link', { name: 'Log in with Discord' })).toBeTruthy();
        expect(requestsTo(api, 'POST', '/api/auth/logout')).toHaveLength(1);
        expect(cache().getQueryData(listGuildsQueryKey())).toBeUndefined();
    });
});
