import { ChannelType, Guild, PermissionsBitField, type GuildBasedChannel } from 'discord.js';

export type LevelingNotificationChannelValidation =
    | { ok: true; channelId: string }
    | { ok: false; userMessage: string; logMessage: string };

export async function validateLevelingNotificationChannel(
    guild: Guild,
    channelId: string
): Promise<LevelingNotificationChannelValidation> {
    const selectedChannel = await guild.channels.fetch(channelId).catch(() => null);

    if (!selectedChannel || selectedChannel.type !== ChannelType.GuildText) {
        return {
            ok: false,
            userMessage: 'Please choose a normal text channel for level-up announcements.',
            logMessage: 'Selected channel is not a guild text channel',
        };
    }

    const permissionResult = await validateBotCanSendInChannel(guild, selectedChannel);
    if (!permissionResult.ok) {
        return permissionResult;
    }

    return { ok: true, channelId: selectedChannel.id };
}

async function validateBotCanSendInChannel(
    guild: Guild,
    channel: GuildBasedChannel
): Promise<LevelingNotificationChannelValidation> {
    const botMember = guild.members.me ?? (await guild.members.fetchMe());
    const permissions = channel.permissionsFor(botMember);

    if (
        !permissions.has(PermissionsBitField.Flags.ViewChannel) ||
        !permissions.has(PermissionsBitField.Flags.SendMessages)
    ) {
        return {
            ok: false,
            userMessage: `I need View Channel + Send Messages in <#${channel.id}> before I can use it.`,
            logMessage: 'Bot lacks permissions in leveling notification channel',
        };
    }

    return { ok: true, channelId: channel.id };
}
