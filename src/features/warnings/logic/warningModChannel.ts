import { ChannelType, Guild, PermissionsBitField, type GuildBasedChannel, type TextChannel } from 'discord.js';

export type WarningModChannelValidation =
    | { ok: true; channelId: string }
    | { ok: false; userMessage: string; logMessage: string };

const REQUIRED_CHANNEL_PERMISSIONS = [
    PermissionsBitField.Flags.ViewChannel,
    PermissionsBitField.Flags.SendMessages,
    PermissionsBitField.Flags.EmbedLinks,
] as const;

export function botCanPostWarningNotice(
    permissions: Readonly<PermissionsBitField> | null | undefined
): boolean {
    return permissions?.has([...REQUIRED_CHANNEL_PERMISSIONS]) ?? false;
}

/**
 * This guild's channel by id, from the cache only.
 *
 * Never `guild.channels.fetch`: for an id this guild's cache does not hold, discord.js asks
 * Discord for `GET /channels/{id}` — any channel anywhere — and a 403 for a guild the bot is
 * not in counts towards Discord's invalid-request IP ban. The id arrives from a request
 * body, so that would be a REST call per request on whatever id somebody sends. The cache
 * is complete without it: the `Guilds` intent delivers every channel of a guild at
 * GUILD_CREATE and keeps them current, so an id missing from it is not this guild's text
 * channel.
 */
function cachedGuildChannel(guild: Guild, channelId: string): GuildBasedChannel | null {
    return guild.channels.cache.get(channelId) ?? null;
}

export async function validateWarningsModChannel(
    guild: Guild,
    channelId: string
): Promise<WarningModChannelValidation> {
    const selectedChannel = cachedGuildChannel(guild, channelId);

    if (!selectedChannel || selectedChannel.type !== ChannelType.GuildText) {
        return {
            ok: false,
            userMessage: 'Please choose a normal text channel for warning notices.',
            logMessage: 'Selected channel is not a guild text channel',
        };
    }

    return validateBotCanPostInChannel(guild, selectedChannel);
}

export async function resolveWarningsModChannel(
    guild: Guild,
    channelId: string
): Promise<TextChannel | null> {
    if (!channelId) {
        return null;
    }

    const channel = cachedGuildChannel(guild, channelId);
    if (!channel || channel.type !== ChannelType.GuildText) {
        return null;
    }

    const botMember = guild.members.me ?? (await guild.members.fetchMe());
    if (!botCanPostWarningNotice(channel.permissionsFor(botMember))) {
        return null;
    }

    return channel;
}

async function validateBotCanPostInChannel(
    guild: Guild,
    channel: GuildBasedChannel
): Promise<WarningModChannelValidation> {
    const botMember = guild.members.me ?? (await guild.members.fetchMe());
    const permissions = channel.permissionsFor(botMember);

    if (!botCanPostWarningNotice(permissions)) {
        return {
            ok: false,
            userMessage: `I need View Channel + Send Messages + Embed Links in <#${channel.id}> before I can post there.`,
            logMessage: 'Bot lacks permissions in warnings mod channel',
        };
    }

    return { ok: true, channelId: channel.id };
}
