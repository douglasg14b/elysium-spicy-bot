import { GuildMember } from 'discord.js';
import { TICKETING_CONFIG } from '../ticketsConfig';

export function memberHasModeratorRole(member: GuildMember) {
    return TICKETING_CONFIG.moderationRoles.some((role) => member.roles.cache.some((r) => r.name === role));
}

export function memberHasModeratorPerms(member: GuildMember) {
    return member.permissions.has('ModerateMembers');
}
