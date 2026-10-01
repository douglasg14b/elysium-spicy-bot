import { ChannelType, type Guild, type GuildBasedChannel } from 'discord.js';
import { DISCORD_UNKNOWN_CHANNEL, discordErrorCode } from './discordErrors';
import type { ResourceKind } from './resourceDeclaration';

/** The channel kinds a bound id can name. Roles are looked up from the role cache. */
export type BoundChannelKind = Exclude<ResourceKind, 'role'>;

/**
 * What a bound channel id resolves to.
 *
 * Two answers, never a third "probably gone". `gone` is reported **only** when Discord
 * itself says `Unknown Channel`; every other failure — a timeout, a 5xx, missing access —
 * throws, because a caller that recreates on `gone` would otherwise mint a duplicate
 * on a network blip. That duplicate is the defect issue #22 recorded, reached by a
 * different door.
 */
export type BoundChannelLookup =
    | { readonly status: 'found'; readonly channel: GuildBasedChannel }
    | { readonly status: 'gone' };

/**
 * Resolve a channel the bot has bound by id: cache first, then one fetch.
 *
 * The fetch matters. The cache is filled by the gateway and is normally complete, but a
 * cache miss is not proof of absence, and the decision this answer feeds — recreate the
 * object — is not one to take on a cache's word.
 *
 * A channel that exists but is the wrong kind throws rather than reporting `gone`: ids are
 * never reused, so it means the binding pointed at the wrong thing from the start, and
 * recreating would hide that.
 */
export async function lookupBoundChannel(
    guild: Guild,
    kind: BoundChannelKind,
    discordId: string
): Promise<BoundChannelLookup> {
    let channel: GuildBasedChannel | null | undefined = guild.channels.cache.get(discordId);

    if (!channel) {
        try {
            channel = await guild.channels.fetch(discordId);
        } catch (error) {
            if (discordErrorCode(error) === DISCORD_UNKNOWN_CHANNEL) return { status: 'gone' };
            throw error;
        }
    }

    if (!channel) {
        throw new Error(`Discord returned nothing for channel ${discordId}, and did not say it was unknown.`);
    }

    const expectedType = kind === 'category' ? ChannelType.GuildCategory : ChannelType.GuildText;
    if (channel.type !== expectedType) {
        throw new Error(`Channel ${discordId} exists but is not a ${kind === 'category' ? 'category' : 'text channel'}.`);
    }

    return { status: 'found', channel };
}
