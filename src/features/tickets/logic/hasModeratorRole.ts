import type { Guild, GuildMember } from 'discord.js';

/**
 * Whether a stored moderation role id may grant anything: a role this guild still has, and
 * never `@everyone`.
 *
 * Checked where the list is *used*, not only where it is saved. Both save paths refuse
 * `@everyone` now, but a config saved before they did can still hold it — its id is the
 * guild id — and every member holds `@everyone`, so read as stored it makes the whole server
 * ticket moderators and puts a staff allow beside the `@everyone` deny on every ticket
 * channel. Managed roles are refused at save time only: one already stored keeps working.
 */
export function isUsableModerationRole(guild: Guild, roleId: string): boolean {
    return roleId !== guild.id && guild.roles.cache.has(roleId);
}

/** Whether the member holds one of the stored moderation roles — `@everyone` never counts, as above. */
export function memberHasModeratorRole(member: GuildMember, roleIds: string[]) {
    return roleIds.some((roleId) => roleId !== member.guild.id && member.roles.cache.has(roleId));
}

export function memberHasModeratorPerms(member: GuildMember) {
    return member.permissions.has('ModerateMembers');
}
