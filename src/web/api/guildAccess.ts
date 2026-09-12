import { ADMIN_DISCORD_IDS } from '../../environment';
import type { SessionUser } from '../auth/session';

/**
 * Whether the authed user may act on a guild. Allowlisted admins see everything
 * (single-tenant); otherwise the guild must be in their manageable set. Callers
 * still constrain to guilds the bot is actually in.
 *
 * Shared by every `/api/guilds/:guildId/...` route group.
 */
export function mayAccessGuild(user: SessionUser, guildId: string): boolean {
    if (ADMIN_DISCORD_IDS.includes(user.id)) return true;
    return user.manageableGuildIds.includes(guildId);
}
