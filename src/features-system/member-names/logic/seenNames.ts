import type { GuildMember, PartialGuildMember, User } from 'discord.js';
import type { SeenMember, SeenUser } from '../data/memberNamesRepo';

/** An account's names as the repo records them. */
export function seenUser(user: User): SeenUser {
    return { userId: user.id, username: user.username, globalName: user.globalName, isBot: user.bot };
}

/**
 * A member's names as the repo records them. A partial member — a leave for somebody the
 * bot never cached — still carries the whole user Discord sent with it; its nickname is
 * unknown, and reads as none.
 */
export function seenMember(member: GuildMember | PartialGuildMember): SeenMember {
    return { ...seenUser(member.user), nickname: member.nickname };
}

/** Whether two sightings of one member carry the same everything the repo records. */
export function sameNames(before: SeenMember, after: SeenMember): boolean {
    return (
        before.nickname === after.nickname &&
        before.username === after.username &&
        before.globalName === after.globalName &&
        before.isBot === after.isBot
    );
}
