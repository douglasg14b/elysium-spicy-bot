import { PermissionFlagsBits, type GuildMember } from 'discord.js';
import type { Viewers } from './visibleChannels';

/**
 * Whether `member` counts as staff for the chat agent: one of the server's staff roles
 * (Server Settings), or the owner, or an Administrator — the people who can already use
 * the dashboard count before any staff roles are set.
 */
export function isStaffMember(member: GuildMember, staffRoleIds: readonly string[]): boolean {
    if (member.id === member.guild.ownerId) return true;
    if (member.permissions.has(PermissionFlagsBits.Administrator)) return true;
    return staffRoleIds.some((roleId) => member.roles.cache.has(roleId));
}

/** Who may hear about the bot's features in this turn, and why not when not. */
export type StaffHelpAccess = 'allowed' | 'askerNotStaff' | 'readersNotStaff' | 'readersUnknown';

/**
 * The asker must be staff, and so must everyone else who can read the answer — the bot's
 * features and this server's setup are told only where every reader is staff.
 *
 * The readers are the guild's member cache (`viewersOf`), which is whole only once the
 * member-names sweep has fetched the server. Until then a member nobody has seen yet is no
 * reader at all, so a cache short of `memberCount` refuses rather than counting the
 * readers it holds.
 */
export function staffHelpAccess(viewers: Viewers, staffRoleIds: readonly string[]): StaffHelpAccess {
    const [asker, ...readers] = viewers;
    if (!isStaffMember(asker, staffRoleIds)) return 'askerNotStaff';
    if (asker.guild.members.cache.size < asker.guild.memberCount) return 'readersUnknown';
    return readers.every((reader) => isStaffMember(reader, staffRoleIds)) ? 'allowed' : 'readersNotStaff';
}
