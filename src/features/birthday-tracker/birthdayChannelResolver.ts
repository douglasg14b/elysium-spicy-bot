import { ChannelType, Client, PermissionFlagsBits, TextChannel } from 'discord.js';

/**
 * Resolves the configured announcement channel and ensures the bot can view and send messages.
 */
export async function resolveBirthdayAnnouncementChannel(
    client: Client,
    guildId: string,
    channelId: string
): Promise<TextChannel | null> {
    const guild =
        client.guilds.cache.get(guildId) ?? (await client.guilds.fetch(guildId).catch(() => null));
    if (!guild) {
        return null;
    }

    const channel =
        guild.channels.cache.get(channelId) ?? (await guild.channels.fetch(channelId).catch(() => null));
    if (!channel || channel.type !== ChannelType.GuildText) {
        return null;
    }

    const me = guild.members.me;
    if (!me) {
        return null;
    }

    const perms = channel.permissionsFor(me);
    if (!perms?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages])) {
        return null;
    }

    return channel;
}
