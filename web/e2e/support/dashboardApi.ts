import type { Client } from 'discord.js';
import { Hono } from 'hono';
import { onTestFinished, vi } from 'vitest';
import { journeyRoutes } from '../../../src/web/api/journeyRoutes';
import type { AppEnv } from '../../../src/web/types';

/** A request the dashboard sent, as the bot's API received it. */
export interface DashboardRequest {
    readonly method: string;
    /** Pathname plus search. */
    readonly path: string;
}

export interface DashboardApi {
    /** Every request the dashboard sent, in order. */
    readonly requests: readonly DashboardRequest[];
}

/**
 * Serve the dashboard's `fetch` from the bot's real API routes, for one test.
 *
 * The routes, the provisioning engine behind them, the database and discord.js are all
 * the production modules. Two things are replaced:
 *
 *  - **The network.** `fetch` is handed to Hono's `app.request` directly, so no port is
 *    bound.
 *  - **Authentication.** `requireAuth` and `requireGuildAccess` need a session cookie and
 *    Discord OAuth. This resolves the guild from `client` instead, the way
 *    `requireGuildAccess` resolves it from the bot's cache, and sets it on the context
 *    where every guild route reads it. Who may reach a guild is not under test here; the
 *    middleware has its own suite.
 *
 * Only the routers a test needs are mounted, so a new dashboard call fails loudly
 * instead of reaching something half-wired.
 *
 * **Anything the product would not normally answer is a fault**: a route that isn't
 * mounted, a guild the client does not hold, or an unhandled exception in a route. The
 * dashboard turns every one of those into a quiet error message, so each is recorded
 * and rethrown when the test finishes. Designed refusals (4xx a route returns itself)
 * reach the component as normal. This is the rule `installFakeApi` and TestDiscord
 * follow too.
 */
export function installDashboardApi(client: Client<true>): DashboardApi {
    const requests: DashboardRequest[] = [];
    const faults: string[] = [];

    const app = new Hono<AppEnv>();

    app.use('/api/guilds/:guildId/*', async (c, next) => {
        const guild = client.guilds.cache.get(c.req.param('guildId'));
        if (!guild) {
            faults.push(`${c.req.method} ${c.req.path}: the client holds no guild ${c.req.param('guildId')}`);
            return c.json({ error: 'Unknown guild.' }, 404);
        }
        c.set('guild', guild);
        await next();
    });
    app.route('/api/guilds', journeyRoutes());

    app.notFound((c) => {
        faults.push(`${c.req.method} ${c.req.path}: no route is mounted for this`);
        return c.json({ error: 'Not found.' }, 404);
    });
    app.onError((error, c) => {
        faults.push(`${c.req.method} ${c.req.path}: ${error.stack ?? String(error)}`);
        return c.json({ error: 'Internal error.' }, 500);
    });

    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = new URL(typeof input === 'string' ? input : input.toString(), 'http://dashboard.test');
        const path = `${url.pathname}${url.search}`;
        requests.push({ method: (init?.method ?? 'GET').toUpperCase(), path });
        return app.request(path, init);
    });

    onTestFinished(() => {
        vi.unstubAllGlobals();
        if (faults.length > 0) {
            throw new Error(`The dashboard hit something the API does not answer:\n  ${faults.join('\n  ')}`);
        }
    });

    return { requests };
}
