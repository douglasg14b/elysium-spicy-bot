import type { SessionUser } from './auth/session';

/**
 * Typed Hono bindings for the web app. The auth middleware sets `user` on the
 * context; protected handlers read it via `c.get('user')` with full types.
 */
export interface AppEnv {
    Variables: {
        user: SessionUser;
    };
}
