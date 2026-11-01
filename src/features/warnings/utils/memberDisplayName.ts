import {
    GuildMember,
    type APIInteractionDataResolvedGuildMember,
    type APIInteractionGuildMember,
    type User,
} from 'discord.js';

/** A member as an interaction hands it over: resolved from the cache, raw from the payload, or absent. */
type InteractionMember = GuildMember | APIInteractionGuildMember | APIInteractionDataResolvedGuildMember | null | undefined;

/**
 * What `user` is called in this server: their nickname here, else their global display
 * name, else their username — the name a warning records for them.
 *
 * An interaction's member is a `GuildMember` only when the guild is cached; otherwise it is
 * the raw payload, which carries the nickname as `nick`.
 */
export function memberDisplayName(member: InteractionMember, user: User): string {
    if (member instanceof GuildMember) {
        return member.displayName;
    }

    return member?.nick ?? user.displayName;
}
