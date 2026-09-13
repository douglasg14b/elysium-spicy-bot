import { createMiddleware } from 'hono/factory';
import { DISCORD_CLIENT } from '../../discordClient';
import { mayAccessGuild } from '../api/guildAccess';
import type { AppEnv } from '../types';
import { readSession } from './session';

/**
 * Verifies the session cookie and puts the authed user on the context.
 * Responds 401 when there is no valid session. Applied to protected `/api/*` routes
 * (everything except health and the auth login/callback endpoints).
 */
export const requireAuth = createMiddleware<AppEnv>(async (c, next) => {
    const user = await readSession(c);
    if (!user) {
        return c.json({ error: 'Not authenticated' }, 401);
    }
    c.set('user', user);
    await next();
});

/**
 * Authorizes the `:guildId` path param and puts the resolved guild on the context.
 *
 * Applied once to the whole `/api/guilds/:guildId/*` tree rather than repeated in each
 * handler: a per-handler check is one forgotten line away from an unguarded route, and
 * this check is now async (it re-verifies against live Discord state), which makes it
 * easy to leave un-awaited. Runs after {@link requireAuth}, so `user` is set.
 */
export const requireGuildAccess = createMiddleware<AppEnv>(async (c, next) => {
    const user = c.get('user');
    const guildId = c.req.param('guildId');

    if (!guildId) {
        return c.json({ error: 'Missing server id.' }, 400);
    }
    if (!(await mayAccessGuild(user, guildId))) {
        return c.json({ error: 'You do not have access to this server.' }, 403);
    }

    const guild = DISCORD_CLIENT.guilds.cache.get(guildId);
    if (!guild) {
        return c.json({ error: 'Server not found.' }, 404);
    }

    c.set('guild', guild);
    await next();
});
