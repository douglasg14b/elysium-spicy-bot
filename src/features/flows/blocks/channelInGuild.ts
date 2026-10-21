import type { Guild, GuildTextBasedChannel } from 'discord.js';
import { asGuildTextChannel } from '../engine/runChannel';

/**
 * The channel a block posts into, resolved from the run's own guild — or a thrown error.
 *
 * **The run's guild, never the client.** The id comes from a flow's config, and a
 * client-wide lookup resolves a channel in *any* server the bot is in: a flow in one server
 * could post as the bot into another. `guild.channels.fetch` refuses a channel that is not
 * this guild's, so a miss in the cache may ask it.
 *
 * The cache answers first because the Guilds intent keeps every channel of the guild in it,
 * so the fetch is only ever for what the cache cannot hold: an archived thread, which a run
 * that parked past the thread going quiet still has to reach (sending unarchives it). An
 * author cannot aim that fetch at another server's channel any more: a literal id that is
 * not this guild's is refused when the flow is saved (`guildReferenceIssues`), so what
 * reaches it is a token filled from an event in this guild, or a channel deleted since.
 * Runs do not re-check readiness, so a graph stored before that check could still name one;
 * the fetch then costs one request to Discord and still refuses it.
 *
 * Thrown rather than returned as `fail`, the convention of the blocks that post: a channel
 * that has stopped being sendable is the world changing underneath a saved flow, not an
 * outcome the block expects. The message says only that the channel is not usable *here*,
 * never whether it exists somewhere else.
 */
export async function requireChannelInGuild(guild: Guild, channelId: string): Promise<GuildTextBasedChannel> {
    const channel = asGuildTextChannel(
        guild.channels.cache.get(channelId) ?? (await guild.channels.fetch(channelId).catch(() => null))
    );
    if (!channel) {
        throw new Error(`Channel ${channelId} is not a sendable text channel in this server`);
    }
    return channel;
}
