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

export async function validateWarningsModChannel(
    guild: Guild,
    channelId: string
): Promise<WarningModChannelValidation> {
    const selectedChannel = await guild.channels.fetch(channelId).catch(() => null);

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

    const channel = await guild.channels.fetch(channelId).catch(() => null);
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
