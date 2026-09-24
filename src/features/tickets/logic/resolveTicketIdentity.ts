import type { Guild, GuildMember, User } from 'discord.js';
import type { TicketIdentity } from '../data/ticketsSchema';

/**
 * The two names to record for a person on a ticket.
 *
 * Takes a `User`, not a user id, and the return is **not** nullable. The username
 * is always knowable from the `User` the caller already holds, so only the
 * nickname depends on a fetch — which means a subject who has left the guild
 * records their username with a null nickname. An all-or-nothing
 * `TicketIdentity | null` could not express that; it would have thrown away a
 * name already in hand.
 *
 * `member.nickname` rather than `member.displayName`, deliberately: `displayName`
 * falls back to the username, so storing it loses the distinction between "no
 * nickname" and "nickname that happens to match". A surface rendering these needs
 * that to avoid printing `someuser (@someuser)`.
 *
 * The `.catch(() => null)` is scoped to the member fetch alone so it cannot
 * swallow a rate-limit into a fabricated username. Note the honest cost: this
 * adds one member fetch on the mod open path — a real Discord call on a feature
 * whose design goal was to stay off Discord — accepted because it happens once at
 * open rather than once per render, which is the trade the snapshot exists to
 * make.
 */
export async function resolveTicketIdentity(guild: Guild, user: User): Promise<TicketIdentity> {
    const member = await guild.members.fetch(user.id).catch(() => null);

    return { username: user.username, nickname: member?.nickname ?? null };
}

/**
 * The same two names, when the caller already holds the `GuildMember`.
 *
 * No fetch at all. Separate from {@link resolveTicketIdentity} rather than an
 * overload because the flow path has a `GuildMember` in hand and paying for a
 * fetch to reach data it is already holding is the cost this whole table exists
 * to avoid.
 */
export function ticketIdentityFromMember(member: GuildMember): TicketIdentity {
    return { username: member.user.username, nickname: member.nickname };
}
