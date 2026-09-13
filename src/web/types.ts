import type { Guild } from 'discord.js';
import type { SessionUser } from './auth/session';

/**
 * Typed Hono bindings for the web app. `requireAuth` sets `user`; `requireGuildAccess`
 * additionally sets `guild` for `/api/guilds/:guildId/*` routes, so handlers under that
 * prefix can read `c.get('guild')` without re-resolving or re-checking access.
 */
export interface AppEnv {
    Variables: {
        user: SessionUser;
        guild: Guild;
    };
}
