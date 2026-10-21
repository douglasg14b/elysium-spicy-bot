import type { OpenAPIHono } from '@hono/zod-openapi';
import { bodyLimit } from 'hono/body-limit';
import type { AppEnv } from '../types';
import { requireAuth, requireGuildAccess } from '../auth/middleware';
import { dashboardRateLimiter } from '../rateLimit';
import { authRoutes } from './authRoutes';
import { botRoutes } from './botRoutes';
import { flowRoutes } from './flowRoutes';
import { guildRoutes } from './guildRoutes';
import { healthRoutes } from './healthRoutes';
import { journeyRoutes } from './journeyRoutes';
import { levelingRoutes } from './levelingRoutes';
import { nodeRoutes } from './nodeRoutes';
import { ticketRoutes } from './ticketRoutes';

/**
 * The largest request body any `/api` route accepts: 1 MiB.
 *
 * The flow graph is the only large body, and nothing caps its node count, so this is sized
 * rather than derived: one Send Message node holding a full 2000-character message, with its
 * edge, is about 2.3 KB of JSON, so a graph of some 450 of them fits — or about 160 if every
 * character takes three bytes. The seeded onboarding flow, with a 2000-character welcome DM,
 * is 2.8 KB.
 */
export const API_BODY_LIMIT_BYTES = 1024 * 1024;

/** What a body over {@link API_BODY_LIMIT_BYTES} is told. */
export const BODY_TOO_LARGE_SENTENCE = 'That body is way too much for me to take in one go. Trim it down and try again.';

/**
 * The cap on every `/api` body. Answers the 413 itself rather than throwing: the default
 * throws a plain-text one, which the root error handler would pass on as it is instead of
 * in the API's envelope.
 */
export const apiBodyLimit = bodyLimit({
    maxSize: API_BODY_LIMIT_BYTES,
    onError: (c) => c.json({ error: BODY_TOO_LARGE_SENTENCE }, 413),
});

/**
 * Registers all JSON API routes under /api.
 *
 * Public: `/api/health`, `/api/bot`, `/api/auth/login`, `/api/auth/callback`,
 * `/api/auth/me` (me self-reports 401 when there is no session). Everything else — the
 * guild/config data routes, the flow builder routes, `/api/nodes`, and
 * `/api/auth/logout` — sits behind {@link requireAuth}, mounted here rather than on any
 * router: a router built with `apiRouter` carries no middleware of its own. Every authed
 * request but logout is then counted against the signed-in user's budgets (`rateLimit.ts`),
 * which is why `AUTHED_ERRORS` declares a 429 and `SESSION_ERRORS` does not.
 *
 * Every body is capped at {@link API_BODY_LIMIT_BYTES} before anything else runs, authed or
 * not. One that declares its length is refused unread; one sent without a length is read up
 * to the cap and no further.
 *
 * `app` is an `OpenAPIHono` because a parent collects the OpenAPI definitions of the
 * routers mounted on it only if it is one itself (see `openApi.ts`). The spec is built
 * from this same function, so its paths carry `/api` from the mount the server really
 * uses rather than from a second copy of the prefix.
 */
export function registerApiRoutes(app: OpenAPIHono<AppEnv>): void {
    // First, so no route's validator reads a body past the cap.
    app.use('/api/*', apiBodyLimit);

    // Liveness. Public, and touches nothing behind it.
    app.route('/api/health', healthRoutes());

    // Which bot account we are connected to. Public: the login page brands itself
    // from this before a session exists.
    app.route('/api/bot', botRoutes());

    // Auth surface. Login, callback and me are public; logout needs the session it clears.
    // Logout is not rate limited: it only clears the cookie, and a refusal would leave a
    // session standing that the dashboard has already shown as signed out.
    app.use('/api/auth/logout', requireAuth);
    app.route('/api/auth', authRoutes());

    // Data routes require a valid session. Hono's `/api/guilds/*` matches `/api/guilds`
    // itself as well, so each of these covers the guild list once.
    app.use('/api/guilds/*', requireAuth);
    // Before `requireGuildAccess`, whose live permission check can itself ask Discord for
    // the member.
    app.use('/api/guilds/*', dashboardRateLimiter.middleware);
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
    // Tickets — the list, one ticket, the four lifecycle actions and the ticket config.
    // Same prefix again, so `requireGuildAccess` above already authorizes every route
    // in it and the router adds no middleware of its own. A ticket is moderator-facing
    // data in a guild the caller already administers, so it is the existing tier
    // rather than a second authorization concept.
    app.route('/api/guilds', ticketRoutes());
    // Leveling — the guild leaderboard and one member's stats. Same prefix again, so
    // `requireGuildAccess` above already authorizes it and the router adds no middleware.
    // A member's XP is moderator-facing data in a guild the caller already administers, so
    // it is the existing tier rather than a second authorization concept.
    app.route('/api/guilds', levelingRoutes());

    // Node catalogue for the builder palette — authed, but not guild-scoped.
    app.use('/api/nodes', requireAuth);
    app.use('/api/nodes', dashboardRateLimiter.middleware);
    app.route('/api/nodes', nodeRoutes());
}
