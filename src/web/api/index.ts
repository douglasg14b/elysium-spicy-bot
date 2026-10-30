import type { OpenAPIHono } from '@hono/zod-openapi';
import { bodyLimit } from 'hono/body-limit';
import { createMiddleware } from 'hono/factory';
import { UPLOAD_BODY_LIMIT_BYTES, UPLOAD_SIZE_LABEL } from '../../features-system/guild-uploads';
import { MIB } from '../../shared/byteSizes';
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
import { memberNameRoutes } from './memberNameRoutes';
import { nodeRoutes } from './nodeRoutes';
import { ticketRoutes } from './ticketRoutes';
import { uploadRoutes } from './uploadRoutes';
import { warningRoutes } from './warningRoutes';

/**
 * The largest request body any `/api` route accepts: 1 MiB.
 *
 * The flow graph is the only large body, and nothing caps its node count, so this is sized
 * rather than derived: one Send Message node holding a full 2000-character message, with its
 * edge, is about 2.3 KB of JSON, so a graph of some 450 of them fits — or about 160 if every
 * character takes three bytes. The seeded onboarding flow, with a 2000-character welcome DM,
 * is 2.8 KB.
 */
export const API_BODY_LIMIT_BYTES = MIB;

/** What a body over {@link API_BODY_LIMIT_BYTES} is told. */
export const BODY_TOO_LARGE_SENTENCE = 'That body is way too much for me to take in one go. Trim it down and try again.';

/** What a picture over {@link UPLOAD_BODY_LIMIT_BYTES} is told. */
export const UPLOAD_TOO_LARGE_SENTENCE = `That picture is a bit too much, even for me. ${UPLOAD_SIZE_LABEL} or less, please.`;

/** What a picture upload sent without a declared length is told. */
export const UPLOAD_LENGTH_REQUIRED_SENTENCE =
    "Tell me how big that picture is first (Content-Length). I don't take mystery packages.";

/** The one route whose body is a picture: `POST /api/guilds/{guildId}/uploads`. */
const UPLOAD_PATH = /^\/api\/guilds\/[^/]+\/uploads$/;

/**
 * Every body but a picture's: read up to {@link API_BODY_LIMIT_BYTES} and no further. Answers
 * its 413 itself rather than throwing: the default throws a plain-text one, which the root
 * error handler would pass on as it is instead of in the API's envelope.
 */
const defaultBodyLimit = bodyLimit({
    maxSize: API_BODY_LIMIT_BYTES,
    onError: (c) => c.json({ error: BODY_TOO_LARGE_SENTENCE }, 413),
});

/**
 * A picture's body is judged by its declared length alone, and never read here.
 *
 * Not `bodyLimit`: given a body with no length, that reads it into memory up to the cap
 * before passing it on, and this runs before the session check — so anyone, signed in or
 * not, could have the server hold 8 MiB per open connection. Instead a picture must declare
 * its length (a browser always does for a `Blob` or `File`, and the SDK's call sends one), a
 * declared length over {@link UPLOAD_BODY_LIMIT_BYTES} is refused unread, and Node's parser
 * stops the handler's read at the declared length.
 */
const uploadLengthLimit = createMiddleware<AppEnv>(async (c, next) => {
    const declared = c.req.header('content-length');
    if (!declared || !/^\d+$/.test(declared) || c.req.header('transfer-encoding') !== undefined) {
        return c.json({ error: UPLOAD_LENGTH_REQUIRED_SENTENCE }, 411);
    }
    if (Number(declared) > UPLOAD_BODY_LIMIT_BYTES) {
        return c.json({ error: UPLOAD_TOO_LARGE_SENTENCE }, 413);
    }
    await next();
});

/**
 * The cap on every `/api` body: {@link UPLOAD_BODY_LIMIT_BYTES} for a picture upload,
 * {@link API_BODY_LIMIT_BYTES} for everything else.
 *
 * One middleware that picks the cap, rather than a second limit on the upload route: both
 * would run, and the smaller would refuse every picture over 1 MiB. Chosen by method and path
 * alone, before anything reads the body.
 */
export const apiBodyLimit = createMiddleware<AppEnv>((c, next) =>
    c.req.method === 'POST' && UPLOAD_PATH.test(c.req.path) ? uploadLengthLimit(c, next) : defaultBodyLimit(c, next)
);

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
 * Every body is capped before anything else runs, authed or not ({@link apiBodyLimit}). A
 * picture upload must declare its length, up to {@link UPLOAD_BODY_LIMIT_BYTES}, and is never
 * read here. Any other body is capped at {@link API_BODY_LIMIT_BYTES}: one that declares its
 * length is refused unread, one sent without a length is read up to the cap and no further.
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
    // Flow CRUD, install and uninstall share the /api/guilds/:guildId prefix (and its auth).
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
    // Warnings — the list, issue, edit and release, and the member search the issue dialog
    // picks from. Same prefix again, so `requireGuildAccess` above already authorizes every
    // route in it and the router adds no middleware of its own.
    app.route('/api/guilds', warningRoutes());
    // Member names — who an id is, for any page that shows one. Same prefix again, so
    // `requireGuildAccess` above already authorizes it and the router adds no middleware.
    app.route('/api/guilds', memberNameRoutes());
    // Leveling — the guild leaderboard and one member's stats. Same prefix again, so
    // `requireGuildAccess` above already authorizes it and the router adds no middleware.
    // A member's XP is moderator-facing data in a guild the caller already administers, so
    // it is the existing tier rather than a second authorization concept.
    app.route('/api/guilds', levelingRoutes());
    // Uploaded pictures — the one route whose body may pass 1 MiB (see `apiBodyLimit`). Same
    // prefix again, so `requireGuildAccess` above authorizes it and the router adds nothing.
    app.route('/api/guilds', uploadRoutes());

    // Node catalogue for the builder palette — authed, but not guild-scoped.
    app.use('/api/nodes', requireAuth);
    app.use('/api/nodes', dashboardRateLimiter.middleware);
    app.route('/api/nodes', nodeRoutes());
}
