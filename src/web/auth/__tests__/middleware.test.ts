import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import type { AppEnv } from '../../types';

/* `environment.ts` reads the secret at import, so it is set before anything below is imported. */
vi.hoisted(() => {
    process.env.SESSION_SECRET ??= 'vitest-session-secret-at-least-32-characters';
});

const { requireAuth, SESSION_USER_HEADER } = await import('../middleware');
const { mintSession, SESSION_COOKIE } = await import('../session');
const { SESSION_USER_HEADER: DASHBOARD_SESSION_USER_HEADER } = await import('../../../../web/src/auth/sessionGate');

/**
 * `requireAuth` on a cookie that may have changed owner under an open tab: the dashboard
 * names who it is signed in as, and a request naming somebody else is refused as if there
 * were no session at all.
 */

const OPERATOR = { id: '200000000000000002', username: 'switch_witch', avatar: null, manageableGuildIds: [] };
const SOMEBODY_ELSE_ID = '200000000000000003';

function app(): Hono<AppEnv> {
    const root = new Hono<AppEnv>();
    root.use('/api/*', requireAuth);
    root.get('/api/probe', (c) => c.json({ userId: c.get('user').id }));
    return root;
}

async function requestAsOperator(headers: Record<string, string> = {}): Promise<Response> {
    return app().request('/api/probe', {
        headers: { Cookie: `${SESSION_COOKIE}=${await mintSession(OPERATOR)}`, ...headers },
    });
}

describe('requireAuth', () => {
    it('reads the header under the name the dashboard sends it', () => {
        // Renaming either side alone would leave the check judging the cookie alone — open, silently.
        expect(SESSION_USER_HEADER).toBe(DASHBOARD_SESSION_USER_HEADER);
    });

    it('refuses a request naming somebody other than the session’s user, as it refuses no session', async () => {
        const response = await requestAsOperator({ [SESSION_USER_HEADER]: SOMEBODY_ELSE_ID });

        expect(response.status).toBe(401);
        expect(await response.json()).toEqual({ error: 'Not authenticated' });
    });

    it('lets through a request naming the session’s own user', async () => {
        const response = await requestAsOperator({ [SESSION_USER_HEADER]: OPERATOR.id });

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ userId: OPERATOR.id });
    });

    it('judges a request naming nobody on the cookie alone', async () => {
        const response = await requestAsOperator();

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ userId: OPERATOR.id });
    });

    it('still refuses a request with no session, whoever it names', async () => {
        const response = await app().request('/api/probe', { headers: { [SESSION_USER_HEADER]: OPERATOR.id } });

        expect(response.status).toBe(401);
    });
});
