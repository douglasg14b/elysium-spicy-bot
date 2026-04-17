import type { GuildMember } from 'discord.js';

export function memberHasModeratorRole(member: GuildMember, roleIds: string[]) {
    return roleIds.some((roleId) => member.roles.cache.has(roleId));
}

export function memberHasModeratorPerms(member: GuildMember) {
    return member.permissions.has('ModerateMembers');
}
