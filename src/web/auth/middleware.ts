import { createMiddleware } from 'hono/factory';
import { DISCORD_CLIENT } from '../../discordClient';
import { mayAccessGuild } from '../api/guildAccess';
import type { AppEnv } from '../types';
import { readSession } from './session';

/**
 * The header the dashboard stamps with the id of the person it is signed in as
 * (`web/src/auth/sessionGate.ts` sends it under the same name; `middleware.test.ts`
 * fails if the two drift).
 */
export const SESSION_USER_HEADER = 'X-BrattyBot-User';

/**
 * Verifies the session cookie and puts the authed user on the context.
 * Responds 401 when there is no valid session. Applied to protected `/api/*` routes
 * (everything except health and the auth login/callback endpoints).
 *
 * Also 401 when the request names, in {@link SESSION_USER_HEADER}, somebody other than
 * the session's user: the cookie changed owner under an open tab — somebody else signed
 * in, in the same browser — and that tab's requests must not be carried out as them. The
 * same answer as no session, so the dashboard's session gate treats it the same way. A
 * request without the header (curl, `/me`, the first load) is judged on the cookie alone.
 */
export const requireAuth = createMiddleware<AppEnv>(async (c, next) => {
    const user = await readSession(c);
    if (!user) {
        return c.json({ error: 'Not authenticated' }, 401);
    }
    const claimedUserId = c.req.header(SESSION_USER_HEADER);
    if (claimedUserId && claimedUserId !== user.id) {
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
