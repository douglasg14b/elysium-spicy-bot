import { PermissionFlagsBits } from 'discord.js';
import { ADMIN_DISCORD_IDS } from '../../environment';
import { DISCORD_CLIENT } from '../../discordClient';
import type { SessionUser } from '../auth/session';

/**
 * Dashboard authorization. The source of truth is Discord itself: a user may configure
 * a server if they own it, are an Administrator, or hold Manage Guild there — computed
 * at login from the OAuth `guilds` payload into {@link SessionUser.manageableGuildIds}.
 *
 * `ADMIN_DISCORD_IDS` is an *optional* superuser override, not a gate. It exists so an
 * operator can reach a server they hold no role in (debugging, support). Leaving it
 * empty is the normal case and means access is purely Discord-permission-driven.
 */

/** Whether this user bypasses per-guild permission checks. Empty allowlist ⇒ nobody. */
export function isSuperuser(userId: string): boolean {
    return ADMIN_DISCORD_IDS.includes(userId);
}

/**
 * Whether the authed user may act on a guild. Superusers see everything; otherwise the
 * session claim must name the guild *and* the user must still hold the permission when
 * we re-check it live (see {@link verifyGuildPermission}).
 *
 * The session claim is checked first because it is free and rejects the common case;
 * the live check then catches permissions revoked since login.
 *
 * Shared by every `/api/guilds/:guildId/...` route group.
 */
export async function mayAccessGuild(user: SessionUser, guildId: string): Promise<boolean> {
    if (isSuperuser(user.id)) return true;
    if (!user.manageableGuildIds.includes(guildId)) return false;
    return verifyGuildPermission(user.id, guildId);
}

/**
 * Whether any guild the user manages is one the bot is actually in — i.e. whether the
 * dashboard has anything at all to show them. Used to reject sign-in with a useful
 * message instead of handing back an empty server list.
 */
export function hasManageableBotGuild(manageableGuildIds: readonly string[]): boolean {
    return manageableGuildIds.some((id) => DISCORD_CLIENT.guilds.cache.has(id));
}

/** The guilds the bot is in that this user may manage. */
export function accessibleGuilds(user: SessionUser) {
    const superuser = isSuperuser(user.id);
    return [...DISCORD_CLIENT.guilds.cache.values()].filter(
        (guild) => superuser || user.manageableGuildIds.includes(guild.id)
    );
}

/**
 * Re-checks a user's permissions against the bot's *live* view of the guild, rather
 * than the snapshot taken at login.
 *
 * `manageableGuildIds` is baked into a 7-day session JWT, so a demoted admin would
 * otherwise keep access until it expired. The bot is in the guild and can see member
 * roles, so it can just ask.
 *
 * Fails closed: a member who has left, lost the role, or whom we cannot fetch is
 * denied. A transient API failure is indistinguishable from a real removal here, and
 * for an authorization check the safe default is "no". The cost of a false negative is
 * one retry; the cost of a false positive is an ex-admin editing your server.
 */
export async function verifyGuildPermission(userId: string, guildId: string): Promise<boolean> {
    const guild = DISCORD_CLIENT.guilds.cache.get(guildId);
    if (!guild) return false;
    try {
        const member = await guild.members.fetch(userId);
        return (
            member.permissions.has(PermissionFlagsBits.Administrator) ||
            member.permissions.has(PermissionFlagsBits.ManageGuild)
        );
    } catch {
        return false;
    }
}
