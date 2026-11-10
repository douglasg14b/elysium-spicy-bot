import { ChannelType, DiscordAPIError, DiscordjsError, DiscordjsErrorCodes, RESTJSONErrorCodes } from 'discord.js';
import type { GuildBasedChannel } from 'discord.js';
import type { ChatToolContext } from './chatToolContext';
import { matchChannel } from './visibleChannels';

/** `https://discord.com/channels/<guild>/<channel>[/<message>]`, from any of Discord's hosts. */
const MESSAGE_LINK = /^<?https?:\/\/(?:(?:ptb|canary)\.)?discord(?:app)?\.com\/channels\/(\d+)\/(\d+)(?:\/(\d+))?>?$/;

type MessageLink = { readonly guildId: string; readonly channelId: string; readonly messageId: string | null };

/** A Discord message or channel link, or null when `text` is not one. */
export function parseMessageLink(text: string): MessageLink | null {
    const match = MESSAGE_LINK.exec(text.trim());
    if (!match) return null;
    const [, guildId, channelId, messageId] = match;
    return { guildId, channelId, messageId: messageId ?? null };
}

/** The channel id a `<#id>` mention or a link names, or null for anything else (a #name is matched against channels, not parsed). */
export function channelIdFromReference(text: string): string | null {
    const trimmed = text.trim();
    return /^<#(\d+)>$/.exec(trimmed)?.[1] ?? parseMessageLink(trimmed)?.channelId ?? null;
}

/** What Discord answers about a channel the bot may not read, or one that is not this server's: none, to the model. */
const NO_SUCH_CHANNEL_CODES: ReadonlySet<number | string> = new Set([
    RESTJSONErrorCodes.UnknownChannel,
    RESTJSONErrorCodes.MissingAccess,
    RESTJSONErrorCodes.MissingPermissions,
]);

export function isNoSuchChannel(error: unknown): boolean {
    if (error instanceof DiscordAPIError) return NO_SUCH_CHANNEL_CODES.has(error.code);
    return error instanceof DiscordjsError && error.code === DiscordjsErrorCodes.GuildChannelUnowned;
}

/**
 * The channel with `id` — a thread nobody has opened since the bot started included — or
 * undefined when there is none the bot may read. A private thread comes with its members
 * fetched: discord.js caches them only from events, and who can see it is who is in it.
 */
async function channelById(context: ChatToolContext, id: string): Promise<GuildBasedChannel | undefined> {
    let channel: GuildBasedChannel | undefined;
    try {
        channel = context.guild.channels.cache.get(id) ?? (await context.guild.channels.fetch(id)) ?? undefined;
    } catch (error) {
        if (isNoSuchChannel(error)) return undefined;
        throw error;
    }
    if (channel?.type === ChannelType.PrivateThread) await channel.members.fetch();
    return channel;
}

/**
 * The channel `query` names, if `admits` lets it through: a link or an id by id (a thread
 * the cache lacks fetched), a name among the cached channels `admits` lets through. `admits`
 * is the staff tool's rule for which channels its readers may be told about.
 */
export async function findAdmittedChannel<Admitted extends GuildBasedChannel>(
    context: ChatToolContext,
    query: string,
    admits: (channel: GuildBasedChannel | undefined) => Admitted | undefined
): Promise<Admitted | undefined> {
    const id = channelIdFromReference(query) ?? (/^\d{15,22}$/.test(query.trim()) ? query.trim() : null);
    if (id) return admits(await channelById(context, id));
    return admits(matchChannel([...context.guild.channels.cache.values()].filter((channel) => admits(channel)), query));
}
