import { OpenAPIHono } from '@hono/zod-openapi';
import { describe, expect, it, vi } from 'vitest';
import type { AppEnv } from '../../types';

/*
 * `environment.ts` reads both at import, and the session is signed with the one and the
 * redirect built from the other — so they are set before anything below is imported.
 */
vi.hoisted(() => {
    process.env.SESSION_SECRET ??= 'vitest-session-secret';
    process.env.WEB_PUBLIC_URL ??= 'https://dashboard.test';
});

const { registerApiRoutes } = await import('../index');
const { mintSession, SESSION_COOKIE } = await import('../../auth/session');
const { OAUTH_STATE_COOKIE } = await import('../../auth/oauth');

/**
 * The auth routes as `registerApiRoutes` mounts them, middleware included: logout's
 * `requireAuth` sits on the parent, not on the route, so it only exists in this assembly.
 *
 * The OAuth exchange with Discord is not exercised — only what the routes decide before
 * and around it: who `/me` says is signed in, that logout needs a session and clears it,
 * that login sends the browser to Discord, and that a callback without our state is refused.
 */

const OPERATOR = { id: '200000000000000002', username: 'switch_witch', avatar: null, manageableGuildIds: [] };

function app(): OpenAPIHono<AppEnv> {
    const root = new OpenAPIHono<AppEnv>();
    registerApiRoutes(root);
    return root;
}

async function sessionCookie(): Promise<string> {
    return `${SESSION_COOKIE}=${await mintSession(OPERATOR)}`;
}

describe('GET /api/auth/me', () => {
    it('answers 401 when nobody is signed in', async () => {
        const response = await app().request('/api/auth/me');

        expect(response.status).toBe(401);
        expect(await response.json()).toEqual({ error: 'Not authenticated' });
    });

    it('names the signed-in user, and nothing else from the session', async () => {
        const response = await app().request('/api/auth/me', { headers: { Cookie: await sessionCookie() } });

        expect(response.status).toBe(200);
        // `manageableGuildIds` stays in the session; the browser is not told which guilds they manage.
        expect(await response.json()).toEqual({ id: OPERATOR.id, username: OPERATOR.username, avatar: null });
    });
});

describe('POST /api/auth/logout', () => {
    it('is refused without a session, by the middleware the parent mounts', async () => {
        const response = await app().request('/api/auth/logout', { method: 'POST' });

        expect(response.status).toBe(401);
        expect(await response.json()).toEqual({ error: 'Not authenticated' });
    });

    it('clears the session cookie', async () => {
        const response = await app().request('/api/auth/logout', {
            method: 'POST',
            headers: { Cookie: await sessionCookie() },
        });

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ ok: true });
        expect(response.headers.get('Set-Cookie')).toMatch(new RegExp(`^${SESSION_COOKIE}=;.*Max-Age=0`));
    });
});

describe('GET /api/auth/login', () => {
    it("redirects the browser to Discord's authorize page with the state it also sets as a cookie", async () => {
        const response = await app().request('/api/auth/login');

        expect(response.status).toBe(302);
        const location = new URL(response.headers.get('Location') ?? '');
        expect(`${location.origin}${location.pathname}`).toBe('https://discord.com/api/oauth2/authorize');
        expect(location.searchParams.get('redirect_uri')).toBe('https://dashboard.test/api/auth/callback');
        const state = location.searchParams.get('state');
        expect(state).toBeTruthy();
        expect(response.headers.get('Set-Cookie')).toContain(`${OAUTH_STATE_COOKIE}=${state}`);
    });
});

describe('GET /api/auth/callback', () => {
    it('refuses a callback that carries no state of ours, before asking Discord anything', async () => {
        const response = await app().request('/api/auth/callback?code=whatever&state=forged');

        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({ error: 'Invalid or expired OAuth state. Try logging in again.' });
    });
});
