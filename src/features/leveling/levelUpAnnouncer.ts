import { ChannelType, Client, Guild, PermissionsBitField, TextChannel } from 'discord.js';
import { LevelingConfig } from './data/levelingConfigSchema';
import { buildLevelUpMessage } from './logic/levelUpMessage';

export async function announceLevelUp(input: {
    client: Client;
    guild: Guild;
    config: LevelingConfig;
    userId: string;
    level: number;
    totalXp: number;
}): Promise<void> {
    const channel = await resolveNotificationChannel(input.guild, input.config.notificationChannelId);
    if (!channel) {
        console.warn(
            `[leveling] Skipping level-up announcement for guild ${input.guild.id}: notification channel unavailable`
        );
        return;
    }

    const botMember = input.guild.members.me ?? (await input.guild.members.fetchMe());
    const permissions = channel.permissionsFor(botMember);

    if (
        !permissions.has(PermissionsBitField.Flags.ViewChannel) ||
        !permissions.has(PermissionsBitField.Flags.SendMessages)
    ) {
        console.warn(
            `[leveling] Skipping level-up announcement for guild ${input.guild.id}: missing permissions in ${channel.id}`
        );
        return;
    }

    const content = buildLevelUpMessage({
        userId: input.userId,
        level: input.level,
        totalXp: input.totalXp,
    });

    try {
        await channel.send({
            content,
            allowedMentions: { users: [input.userId] },
        });
    } catch (error) {
        console.error(`[leveling] Failed to send level-up announcement in guild ${input.guild.id}:`, error);
    }
}

async function resolveNotificationChannel(
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

    return channel;
}
