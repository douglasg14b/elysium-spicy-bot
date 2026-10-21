import { PermissionFlagsBits } from 'discord.js';
import { ADMIN_DISCORD_IDS, ALLOWED_GUILD_IDS } from '../../environment';
import { DISCORD_CLIENT } from '../../discordClient';
import { isGuildAllowed } from '../../features-system/guild-allowlist';
import type { SessionUser } from '../auth/session';

/**
 * Dashboard authorization. The source of truth is Discord itself: a user may configure
 * a server if they own it or are an Administrator there — computed at login from the
 * OAuth `guilds` payload into {@link SessionUser.manageableGuildIds}, and re-checked live
 * on every `/api/guilds/:guildId` request. Manage Server alone does not qualify. The
 * server list ({@link accessibleGuilds}) trusts the login snapshot; opening a server
 * re-checks it. (`manageableGuildIds` and `canManageGuild` keep their names from when
 * Manage Server counted: the claim name is in every live session cookie.)
 *
 * `ADMIN_DISCORD_IDS` is an *optional* superuser override, not a gate. It exists so an
 * operator can reach a server they hold no role in (debugging, support). Leaving it
 * empty is the normal case and means access is purely Discord-permission-driven.
 *
 * `ALLOWED_GUILD_IDS`, when set, bounds all of it: a server off the list is treated as
 * not there, for superusers too.
 */

/** Whether this user bypasses per-guild permission checks. Empty `ADMIN_DISCORD_IDS` ⇒ nobody. */
export function isSuperuser(userId: string): boolean {
    return ADMIN_DISCORD_IDS.includes(userId);
}

/**
 * Whether the authed user may act on a guild. A guild off `ALLOWED_GUILD_IDS` is refused
 * to everyone; otherwise superusers see everything, and anyone else needs the session
 * claim to name the guild *and* to still own or administer it when we re-check it live
 * (see {@link verifyGuildPermission}).
 *
 * The session claim is checked first because it is free and rejects the common case;
 * the live check then catches permissions revoked since login.
 *
 * Shared by every `/api/guilds/:guildId/...` route group.
 */
export async function mayAccessGuild(user: SessionUser, guildId: string): Promise<boolean> {
    if (!isGuildAllowed(guildId, ALLOWED_GUILD_IDS)) return false;
    if (isSuperuser(user.id)) return true;
    if (!user.manageableGuildIds.includes(guildId)) return false;
    return verifyGuildPermission(user.id, guildId);
}

/**
 * Whether any guild the user manages is one the bot is actually in and allowed to serve
 * — i.e. whether the dashboard has anything at all to show them. Used to reject sign-in
 * with a useful message instead of handing back an empty server list.
 */
export function hasManageableBotGuild(manageableGuildIds: readonly string[]): boolean {
    return manageableGuildIds.some(
        (id) => isGuildAllowed(id, ALLOWED_GUILD_IDS) && DISCORD_CLIENT.guilds.cache.has(id)
    );
}

/** The guilds the bot is in and allowed to serve that this user may manage. */
export function accessibleGuilds(user: SessionUser) {
    const superuser = isSuperuser(user.id);
    return [...DISCORD_CLIENT.guilds.cache.values()].filter(
        (guild) =>
            isGuildAllowed(guild.id, ALLOWED_GUILD_IDS) && (superuser || user.manageableGuildIds.includes(guild.id))
    );
}

/**
 * Re-checks a user's standing against the bot's *live* view of the guild, rather than
 * the snapshot taken at login: they must own the guild or hold Administrator there.
 *
 * Ownership is checked on its own because it is not a permission bit — an owner need not
 * hold the Administrator role, and is not asked to.
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
    if (guild.ownerId === userId) return true;
    try {
        const member = await guild.members.fetch(userId);
        return member.permissions.has(PermissionFlagsBits.Administrator);
    } catch {
        return false;
    }
}
