import { GuildMember } from 'discord.js';

export function memberHasModeratorRole(member: GuildMember, roleIds: string[]) {
    return roleIds.some((role) => member.roles.cache.some((r) => r.name === role));
}

export function memberHasModeratorPerms(member: GuildMember) {
    return member.permissions.has('ModerateMembers');
}
