import type { Hono } from 'hono';
import type { AppEnv } from '../types';
import { requireAuth } from '../auth/middleware';
import { authRoutes } from './authRoutes';
import { flowRoutes } from './flowRoutes';
import { guildRoutes } from './guildRoutes';
import { nodeRoutes } from './nodeRoutes';

/**
 * Registers all JSON API routes under /api.
 *
 * Public: `/api/health`, `/api/auth/login`, `/api/auth/callback`, `/api/auth/me`
 * (me self-reports 401 when there is no session). Everything else — the guild/config
 * data routes, the flow builder routes, `/api/nodes`, and `/api/auth/logout` —
 * sits behind {@link requireAuth}.
 */
export function registerApiRoutes(app: Hono<AppEnv>): void {
    app.get('/api/health', (c) =>
        c.json({
            ok: true,
            service: 'spicybot-web',
            time: new Date().toISOString(),
        })
    );

    // Auth surface (login/callback/me are public; logout enforces auth internally).
    app.route('/api/auth', authRoutes());

    // Data routes require a valid session.
    app.use('/api/guilds/*', requireAuth);
    app.use('/api/guilds', requireAuth);
    app.route('/api/guilds', guildRoutes());
    // Flow CRUD + deploy share the /api/guilds/:guildId prefix (and its auth).
    app.route('/api/guilds', flowRoutes());

    // Node catalogue for the builder palette — authed, but not guild-scoped.
    app.use('/api/nodes', requireAuth);
    app.route('/api/nodes', nodeRoutes());
}
