import type { Client } from 'discord.js';
import { Hono, type Context } from 'hono';
import { resolveFlavour, type BotIdentityResponse } from '../../../src/web/api/botRoutes';
import { flowRoutes } from '../../../src/web/api/flowRoutes';
import { guildRoutes } from '../../../src/web/api/guildRoutes';
import { journeyRoutes } from '../../../src/web/api/journeyRoutes';
import { nodeRoutes } from '../../../src/web/api/nodeRoutes';
import { UNEXPECTED_ERROR_SENTENCE } from '../../../src/web/api/openApi';
import { ticketRoutes } from '../../../src/web/api/ticketRoutes';
import type { SessionUser } from '../../../src/web/auth/session';
import type { AppEnv } from '../../../src/web/types';

/** The person the dashboard is signed in as. */
export type DashboardOperator = Pick<SessionUser, 'id' | 'username'>;

export interface DashboardAppOptions {
    /** The bot, as TestDiscord started it. Stands in for `DISCORD_CLIENT` everywhere the API reads it. */
    readonly client: Client<true>;
    readonly operator: DashboardOperator;
    /** Called for anything the product would not normally answer; see {@link buildDashboardApp}. */
    readonly onFault: (fault: string) => void;
    /**
     * Whether the operator's session is still live, asked per request. While it is not,
     * `/api/auth/me` and every route `requireAuth` guards answer its 401; `/api/bot` and
     * `/api/health` still answer. Live throughout when not given.
     */
    readonly sessionLive?: () => boolean;
}

/**
 * The bot's dashboard API, served from the production routers with authentication
 * replaced. Shared by the e2e bridge (`installDashboardApi`) and the preview server, so
 * a page reviewed in a browser and a page asserted on in a test see the same API.
 *
 * Mounted in the order `registerApiRoutes` uses. What is replaced, and why:
 *
 *  - **Sessions and guild access.** `requireAuth` needs a signed cookie from Discord
 *    OAuth and `requireGuildAccess` re-checks the member's permissions live. Here every
 *    request is {@link DashboardAppOptions.operator}, and a guild route resolves its guild
 *    from `client`, the way `requireGuildAccess` resolves it from the bot's cache. Who may
 *    reach a guild has its own suite. A session running out is
 *    {@link DashboardAppOptions.sessionLive}.
 *  - **The three answers that read `DISCORD_CLIENT` directly**: `/api/auth/me`,
 *    `/api/bot`, and the guild list. Each is answered from `client` instead. The guild
 *    list is declared before `guildRoutes` so it answers first.
 *
 * Every route works through the guild it resolved, so its Discord calls reach TestDiscord.
 * One sent through `DISCORD_CLIENT` instead would fail: the singleton is never logged in.
 *
 * **Anything the product would not normally answer is a fault**: an unmounted route, a
 * guild the client does not hold, or an unhandled exception in a route. The dashboard
 * turns each of those into a quiet error message, so each goes to `onFault`. Designed
 * refusals, the 4xx a route returns itself, reach the page as normal.
 */
export function buildDashboardApp({ client, operator, onFault, sessionLive = () => true }: DashboardAppOptions): Hono<AppEnv> {
    const app = new Hono<AppEnv>();
    const user: SessionUser = { ...operator, avatar: null, manageableGuildIds: [...client.guilds.cache.keys()] };
    // What `requireAuth` and `/me` answer without a session.
    const notAuthenticated = (c: Context<AppEnv>) => c.json({ error: 'Not authenticated' }, 401);

    app.get('/api/health', (c) => c.json({ ok: true, service: 'brattybot-web', time: new Date().toISOString() }));
    app.get('/api/bot', (c) =>
        c.json<BotIdentityResponse>({
            ready: true,
            id: client.user.id,
            username: client.user.username,
            flavour: resolveFlavour(client.user.username),
        })
    );
    app.get('/api/auth/me', (c) =>
        sessionLive() ? c.json({ id: user.id, username: user.username, avatar: user.avatar }) : notAuthenticated(c)
    );
    app.post('/api/auth/logout', (c) => (sessionLive() ? c.json({ ok: true }) : notAuthenticated(c)));

    app.use('/api/*', async (c, next) => {
        if (!sessionLive()) return notAuthenticated(c);
        c.set('user', user);
        await next();
    });
    app.use('/api/guilds/:guildId/*', async (c, next) => {
        const guild = client.guilds.cache.get(c.req.param('guildId'));
        if (!guild) {
            onFault(`${c.req.method} ${c.req.path}: the client holds no guild ${c.req.param('guildId')}`);
            return c.json({ error: 'Unknown guild.' }, 404);
        }
        c.set('guild', guild);
        await next();
    });

    app.get('/api/guilds', (c) =>
        c.json({
            guilds: [...client.guilds.cache.values()].map((guild) => ({
                id: guild.id,
                name: guild.name,
                iconURL: guild.iconURL({ size: 128 }),
                memberCount: guild.memberCount,
            })),
        })
    );
    app.route('/api/guilds', guildRoutes());
    app.route('/api/guilds', flowRoutes());
    app.route('/api/guilds', journeyRoutes());
    app.route('/api/guilds', ticketRoutes());
    app.route('/api/nodes', nodeRoutes());

    app.notFound((c) => {
        onFault(`${c.req.method} ${c.req.path}: no route is mounted for this`);
        return c.json({ error: 'Not found.' }, 404);
    });
    app.onError((error, c) => {
        onFault(`${c.req.method} ${c.req.path}: ${error.stack ?? String(error)}`);
        // Production's answer, so a page under test shows what an operator would see.
        return c.json({ error: UNEXPECTED_ERROR_SENTENCE }, 500);
    });

    return app;
}
