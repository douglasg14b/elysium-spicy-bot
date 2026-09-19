import type { Hono } from 'hono';
import type { AppEnv } from '../types';
import { requireAuth, requireGuildAccess } from '../auth/middleware';
import { authRoutes } from './authRoutes';
import { botRoutes } from './botRoutes';
import { flowRoutes } from './flowRoutes';
import { guildRoutes } from './guildRoutes';
import { journeyRoutes } from './journeyRoutes';
import { nodeRoutes } from './nodeRoutes';

/**
 * Registers all JSON API routes under /api.
 *
 * Public: `/api/health`, `/api/bot`, `/api/auth/login`, `/api/auth/callback`,
 * `/api/auth/me` (me self-reports 401 when there is no session). Everything else — the
 * guild/config data routes, the flow builder routes, `/api/nodes`, and
 * `/api/auth/logout` — sits behind {@link requireAuth}.
 */
export function registerApiRoutes(app: Hono<AppEnv>): void {
    app.get('/api/health', (c) =>
        c.json({
            ok: true,
            service: 'brattybot-web',
            time: new Date().toISOString(),
        })
    );

    // Which bot account we are connected to. Public: the login page brands itself
    // from this before a session exists.
    app.route('/api/bot', botRoutes());

    // Auth surface (login/callback/me are public; logout enforces auth internally).
    app.route('/api/auth', authRoutes());

    // Data routes require a valid session.
    app.use('/api/guilds/*', requireAuth);
    app.use('/api/guilds', requireAuth);
    // Everything scoped to a specific guild is authorized once, here. `/api/guilds`
    // itself is deliberately not covered: it lists the guilds you may access, so it
    // filters rather than rejects.
    app.use('/api/guilds/:guildId/*', requireGuildAccess);
    app.route('/api/guilds', guildRoutes());
    // Flow CRUD + deploy share the /api/guilds/:guildId prefix (and its auth).
    app.route('/api/guilds', flowRoutes());
    // Journey CRUD shares the same prefix — a journey is guild-scoped structure, and
    // authorizing it separately would be a second answer to the same question.
    app.route('/api/guilds', journeyRoutes());

    // Node catalogue for the builder palette — authed, but not guild-scoped.
    app.use('/api/nodes', requireAuth);
    app.route('/api/nodes', nodeRoutes());
}
