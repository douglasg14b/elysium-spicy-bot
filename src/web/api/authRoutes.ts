import { Hono } from 'hono';
import { ADMIN_DISCORD_IDS, WEB_PUBLIC_URL } from '../../environment';
import type { AppEnv } from '../types';
import {
    buildAuthorizeUrl,
    exchangeCode,
    fetchDiscordUser,
    fetchManageableGuildIds,
    issueState,
    verifyState,
} from '../auth/oauth';
import { requireAuth } from '../auth/middleware';
import { clearSessionCookie, mintSession, readSession, writeSessionCookie } from '../auth/session';

/**
 * Auth surface: `/api/auth/*`. Login + callback are public; me + logout require
 * (or clear) a session. See design doc §5.2.
 */
export function authRoutes(): Hono<AppEnv> {
    const app = new Hono<AppEnv>();

    // Kick off the OAuth flow: redirect to Discord with a signed CSRF state.
    app.get('/login', async (c) => {
        const state = await issueState(c);
        return c.redirect(buildAuthorizeUrl(state));
    });

    // OAuth callback: verify state, exchange code, authorize against the allowlist, mint a session.
    app.get('/callback', async (c) => {
        const code = c.req.query('code');
        const state = c.req.query('state');

        if (!(await verifyState(c, state))) {
            return c.json({ error: 'Invalid or expired OAuth state. Try logging in again.' }, 400);
        }
        if (!code) {
            return c.json({ error: 'Missing authorization code.' }, 400);
        }

        let user;
        let manageableGuildIds: string[];
        try {
            const { access_token } = await exchangeCode(code);
            user = await fetchDiscordUser(access_token);
            manageableGuildIds = await fetchManageableGuildIds(access_token);
        } catch (err) {
            console.error('[web/auth] OAuth callback failed:', err);
            return c.json({ error: 'Failed to complete Discord sign-in.' }, 502);
        }

        // Single-tenant allowlist gate.
        if (!ADMIN_DISCORD_IDS.includes(user.id)) {
            return c.json(
                { error: 'This account is not on the SpicyBot admin allowlist. Access denied.' },
                403
            );
        }

        const token = await mintSession({
            id: user.id,
            username: user.username,
            avatar: user.avatar,
            manageableGuildIds,
        });
        writeSessionCookie(c, token);

        // Back to the SPA root.
        return c.redirect(`${WEB_PUBLIC_URL}/`);
    });

    // Current session (public: returns 401 when there is none).
    app.get('/me', async (c) => {
        const user = await readSession(c);
        if (!user) {
            return c.json({ error: 'Not authenticated' }, 401);
        }
        return c.json({
            id: user.id,
            username: user.username,
            avatar: user.avatar,
        });
    });

    // Clear the session cookie.
    app.post('/logout', requireAuth, (c) => {
        clearSessionCookie(c);
        return c.json({ ok: true });
    });

    return app;
}
