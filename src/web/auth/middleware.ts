import { createMiddleware } from 'hono/factory';
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
