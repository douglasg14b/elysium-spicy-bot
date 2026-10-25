import type { MiddlewareHandler } from 'hono';
import { createMiddleware } from 'hono/factory';
import type { AppEnv } from './types';

/**
 * Per-user request budgets for the dashboard API.
 *
 * Keyed by the **session user id**, never by address: every request reaches the app through
 * `cloudflared`, so they all share one source address (see `infra/README.md`). Cloudflare
 * limits the login and the OAuth callback per IP at the edge; everything after login is
 * limited here, per person.
 *
 * Two budgets, each a fixed window per user:
 *  - **general** — every authed request. Sized so a page load's burst of reads and the Flow
 *    Builder's autosaves never come near it.
 *  - **discord** — requests whose handler calls Discord ({@link callsDiscord}). A signed-in
 *    user looping one of these could otherwise get the bot rate-limited, or its IP banned
 *    (Discord bans an IP at 10,000 401/403/429 answers in ten minutes).
 *
 * In memory, so a restart forgets every count, and a second process would keep its own —
 * the bot runs as one process.
 */

/** The budgets a request can be counted against. */
export type RateBudget = 'general' | 'discord';

/** How many requests each budget allows per user in one window. */
export type RateLimits = Readonly<Record<RateBudget, number>>;

export interface RateLimiterOptions {
    readonly windowMs: number;
    readonly limits: RateLimits;
    /** The clock, in epoch milliseconds. A seam for tests; `Date.now` otherwise. */
    readonly now?: () => number;
}

export interface UserRateLimiter {
    /** Mount after `requireAuth`, which puts the user it keys on onto the context. */
    readonly middleware: MiddlewareHandler<AppEnv>;
    /** Forget every count. For tests, which share the app's one limiter. */
    readonly reset: () => void;
    /** How many user/budget counters are held, so a test can see stale ones go. */
    readonly trackedCount: () => number;
}

/** The dashboard's budgets: a minute's window, 300 requests in all and 30 that call Discord. */
export const DASHBOARD_RATE_LIMITS: RateLimiterOptions = {
    windowMs: 60_000,
    limits: { general: 300, discord: 30 },
};

/** What an over-budget request is told. Fixed, whichever budget ran out. */
export const RATE_LIMITED_SENTENCE =
    "Easy, eager — you're clicking faster than I put out. Wait a moment, then try again.";

/**
 * Reads with a handler that calls Discord, as the path below `/api/guilds/{guildId}/`. Unlike
 * writes, a read is in the general budget alone unless it is listed here; the classification
 * gate in `rateLimitClassification.test.ts` fails on any guild route nobody has placed.
 */
const DISCORD_READS: readonly RegExp[] = [
    // Member snapshots for the leaderboard, over the gateway (RequestGuildMembers).
    /^leveling$/,
    /^leveling\/users\/[^/]+$/,
    // A full channel fetch, so drift sees fresh permission overwrites.
    /^journeys\/[^/]+\/drift$/,
    // One message fetch per message resource the journey posted, to tell whether it is still
    // there: the install plan, and the published inventories, which plan a teardown.
    /^flows\/[^/]+\/install-plan$/,
    /^flows\/[^/]+\/published$/,
    /^journeys\/[^/]+\/published$/,
];

/** A method that writes, as Hono reports it. */
type WriteMethod = 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/**
 * Writes that touch only the database, and that the dashboard sends as the author types or
 * moves between fields: the draft autosave (every 2 s of typing), the resource autosave
 * (600 ms) to either of its targets — a flow's resources, or a journey's from the flows page —
 * and the readiness check (on blur and after a structural edit). Counted against the general
 * budget alone, since typing would run through 30 a minute. Also the picture upload, which
 * touches only the database and is bounded by its own per-server total instead, and the
 * picture delete, which touches only the database and frees room rather than taking it. Every other
 * write under a guild counts against the Discord budget, so a new write is covered until it
 * is listed here.
 */
const DATABASE_ONLY_WRITES: readonly { readonly method: WriteMethod; readonly path: RegExp }[] = [
    { method: 'PUT', path: /^flows\/[^/]+\/drafts\/mine$/ },
    { method: 'PUT', path: /^flows\/[^/]+\/resources$/ },
    { method: 'PUT', path: /^journeys\/[^/]+$/ },
    { method: 'POST', path: /^flows\/[^/]+\/check$/ },
    { method: 'POST', path: /^uploads$/ },
    { method: 'DELETE', path: /^uploads\/[^/]+$/ },
];

/** The part of a guild-scoped path after `/api/guilds/{guildId}/`. */
const GUILD_SCOPED_PATH = /^\/api\/guilds\/[^/]+\/(.+)$/;

/**
 * Whether a request's handler calls Discord: any write under `/api/guilds/{guildId}/` but the
 * {@link DATABASE_ONLY_WRITES}, and the {@link DISCORD_READS}. Nothing outside a guild does.
 *
 * Not counted here: `requireGuildAccess`'s own member lookup on every guild-scoped request,
 * which discord.js answers from its cache for a member it holds. The general budget bounds it.
 */
export function callsDiscord(method: string, path: string): boolean {
    const scoped = GUILD_SCOPED_PATH.exec(path)?.[1];
    if (!scoped) return false;
    if (method === 'GET' || method === 'HEAD') {
        return DISCORD_READS.some((pattern) => pattern.test(scoped));
    }
    return !DATABASE_ONLY_WRITES.some((write) => write.method === method && write.path.test(scoped));
}

/** The budgets one request is counted against. */
export function budgetsFor(method: string, path: string): readonly RateBudget[] {
    return callsDiscord(method, path) ? ['general', 'discord'] : ['general'];
}

interface WindowCount {
    readonly windowStart: number;
    count: number;
    /** Whether this window's first refusal has been logged, so a loop logs once a window. */
    logged: boolean;
}

/**
 * A per-user limiter with its own counts. The app uses {@link dashboardRateLimiter}; a test
 * builds its own with a clock it controls.
 *
 * A request every budget it belongs to still has room for is counted against each of them; a
 * request one of them has run out for is refused with a 429 and `Retry-After`, and counted
 * against none. Memory is bounded by the users active in the last window: expired counters
 * are swept at most once a window, on the next request.
 */
export function createUserRateLimiter({ windowMs, limits, now = Date.now }: RateLimiterOptions): UserRateLimiter {
    const counts = new Map<string, WindowCount>();
    let lastSweep = now();

    const sweep = (at: number): void => {
        if (at - lastSweep < windowMs) return;
        lastSweep = at;
        for (const [key, entry] of counts) {
            if (at - entry.windowStart >= windowMs) counts.delete(key);
        }
    };

    const current = (key: string, at: number): WindowCount => {
        const entry = counts.get(key);
        if (entry && at - entry.windowStart < windowMs) return entry;
        const fresh: WindowCount = { windowStart: at, count: 0, logged: false };
        counts.set(key, fresh);
        return fresh;
    };

    const middleware = createMiddleware<AppEnv>(async (c, next) => {
        const user = c.get('user');
        if (!user) {
            throw new Error('The rate limit ran before requireAuth: there is no user to count against.');
        }

        const at = now();
        sweep(at);
        const windows = budgetsFor(c.req.method, c.req.path).map((budget) => ({
            budget,
            entry: current(`${budget}:${user.id}`, at),
        }));

        const exhausted = windows.filter(({ budget, entry }) => entry.count >= limits[budget]);
        if (exhausted.length > 0) {
            for (const { budget, entry } of exhausted) {
                if (entry.logged) continue;
                entry.logged = true;
                console.warn(`[web] user ${user.id} ran out of the ${budget} request budget (${limits[budget]}/window).`);
            }
            // Until the last of them reopens: an earlier answer would only be refused again.
            const reopensAt = Math.max(...exhausted.map(({ entry }) => entry.windowStart + windowMs));
            c.header('Retry-After', String(Math.max(1, Math.ceil((reopensAt - at) / 1000))));
            return c.json({ error: RATE_LIMITED_SENTENCE }, 429);
        }

        for (const { entry } of windows) entry.count += 1;
        await next();
    });

    return {
        middleware,
        reset: () => {
            counts.clear();
            lastSweep = now();
        },
        trackedCount: () => counts.size,
    };
}

/** The dashboard API's one limiter, mounted by `registerApiRoutes`. */
export const dashboardRateLimiter = createUserRateLimiter(DASHBOARD_RATE_LIMITS);
