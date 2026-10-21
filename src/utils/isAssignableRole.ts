import type { Guild } from 'discord.js';

/**
 * Whether a role id may be handed to a feature as a real, grantable role.
 *
 * Shared by the dashboard's role picker, staff-role validation, and both places ticket
 * moderation roles are saved (the dashboard and the Discord modal), because these drifting
 * apart is a security bug rather than an inconsistency. Two exclusions, and the first is
 * the dangerous one:
 *
 *  - **`@everyone`**, whose id *is the guild id*. A plain cache check accepts it. As a
 *    staff role it compiles to an overwrite keyed on the same id as the `everyone`
 *    audience, and since later intents override earlier ones per id
 *    (`compilePermissionIntents`), the canonical "deny everyone, then allow staff"
 *    declaration erases its own deny — producing a world-readable channel that every
 *    plan, embed, and dashboard still reports as staff-only. As a ticket moderation role
 *    it makes every member a ticket moderator.
 *  - **Managed** roles, which belong to a bot or integration and cannot be assigned.
 *
 * Reads the role cache only, which the `Guilds` intent keeps complete.
 */
export function isAssignableRole(guild: Guild, roleId: string): boolean {
    const role = guild.roles.cache.get(roleId);
    return !!role && role.id !== guild.id && !role.managed;
}

/** How many refused role ids a refusal names before it only counts the rest. */
const REFUSED_ROLES_NAMED = 10;

/**
 * The refusal for role ids {@link isAssignableRole} turned down, in one sentence every save
 * path shares.
 *
 * Names the ids so the operator can go and find them — `@everyone` by name, since its id is
 * the server's and means nothing to them — but only the first few: the list comes from a
 * request, and echoing all of a long one would make the server build a message out of as
 * many ids as a caller cared to send.
 */
export function describeRefusedRoles(guild: Guild, refusedIds: readonly string[], asWhat: string): string {
    const named = refusedIds
        .slice(0, REFUSED_ROLES_NAMED)
        .map((roleId) => (roleId === guild.id ? '@everyone' : roleId))
        .join(', ');
    const remainder = refusedIds.length - REFUSED_ROLES_NAMED;
    const suffix = remainder > 0 ? ` (and ${remainder} more)` : '';

    return `These can't be ${asWhat}: ${named}${suffix}. Pick real, assignable roles in this server — @everyone and bot-managed roles don't count.`;
}
