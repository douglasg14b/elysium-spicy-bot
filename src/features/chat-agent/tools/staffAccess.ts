import { PermissionFlagsBits, type GuildMember } from 'discord.js';
import type { ChatToolContext } from './chatToolContext';
import type { Viewers } from './visibleChannels';

/**
 * Whether `member` counts as staff for the chat agent: one of its staff roles
 * (`ChatToolContext.staffRoleIds` — its own list, else Server Settings'), or the owner, or an
 * Administrator — the people who can already use the dashboard count before any staff roles are set.
 */
export function isStaffMember(member: GuildMember, staffRoleIds: readonly string[]): boolean {
    if (member.id === member.guild.ownerId) return true;
    if (member.permissions.has(PermissionFlagsBits.Administrator)) return true;
    return staffRoleIds.some((roleId) => member.roles.cache.has(roleId));
}

/** Whether the staff-only tools (bot features, tickets, channel history, channel access) answer this turn, and why not when not. */
export type StaffHelpAccess = 'allowed' | 'askerNotStaff' | 'readersNotStaff' | 'readersUnknown';

/**
 * The asker must be staff, and so must everyone else who can read the answer — the bot's
 * features, this server's setup, its tickets, other channels' messages and who can see them are told only
 * where every reader is staff.
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

/** Why a staff-only tool won't answer this turn, and how the model should say so. */
type StaffOnlyRefusal = { readonly reason: string; readonly tellThem: string };

/** What a staff-only tool hands the model when the answer is not for this turn, and nothing else. */
export const STAFF_ONLY_REFUSALS: StaffOnlyRefusals = {
    askerNotStaff: {
        reason: 'Only staff can ask this.',
        tellThem: "Turn them down in character — dry, a little smug, no apology: it's above their pay grade, so they can ask a mod. Stop at \"ask a mod\": not what a mod will do or tell them. Say nothing of what they asked about.",
    },
    readersNotStaff: {
        reason: "People who aren't staff can read this channel.",
        tellThem: 'In character, no apology: not where the members can read along — ask again in a channel only staff can see. Say nothing of what they asked about.',
    },
    readersUnknown: {
        reason: "The bot is still loading this server's member list, so it can't yet tell who can read this channel.",
        tellThem: "In character, no apology: you can't vouch for who's reading yet — ask again in a few minutes. Say nothing of what they asked about.",
    },
};

/** A staff-only tool's sentences for each way a turn is not for it. */
export type StaffOnlyRefusals = Readonly<Record<Exclude<StaffHelpAccess, 'allowed'>, StaffOnlyRefusal>>;

/**
 * What a staff-only tool answers instead, when this turn is not for it; null when it may
 * answer. `refusals` for a tool whose subject needs its own words (levels: a member's own
 * level is no secret from them, just not for the channel).
 */
export function staffOnlyRefusal(
    context: Pick<ChatToolContext, 'viewers' | 'staffRoleIds'>,
    refusals: StaffOnlyRefusals = STAFF_ONLY_REFUSALS
): StaffOnlyRefusal | null {
    const access = staffHelpAccess(context.viewers, context.staffRoleIds);
    return access === 'allowed' ? null : refusals[access];
}
