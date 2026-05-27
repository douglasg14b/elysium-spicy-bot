import {
    ChannelType,
    ChatInputCommandInteraction,
    PermissionsBitField,
    SlashCommandBuilder,
} from 'discord.js';
import { commandError, commandSuccess } from '../../../features-system/commands';
import { InteractionHandlerResult } from '../../../features-system/commands/types';
import { levelingConfigRepo } from '../data/levelingConfigRepo';
import { LevelingConfig } from '../data/levelingConfigSchema';
import { validateLevelingNotificationChannel } from '../logic/levelingNotificationChannel';

export const LEVELING_CONFIG_COMMAND_NAME = 'leveling-config';

export const levelingConfigCommand = new SlashCommandBuilder()
    .setName(LEVELING_CONFIG_COMMAND_NAME)
    .setDescription('Configure the server leveling system')
    .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild)
    .addBooleanOption((option) =>
        option.setName('enabled').setDescription('Turn leveling on or off').setRequired(false)
    )
    .addChannelOption((option) =>
        option
            .setName('channel')
            .setDescription('Optional channel for level-up announcements')
            .setRequired(false)
            .addChannelTypes(ChannelType.GuildText)
    );

export async function handleLevelingConfigCommand(
    interaction: ChatInputCommandInteraction
): Promise<InteractionHandlerResult> {
    if (!interaction.inGuild() || !interaction.guildId || !interaction.guild) {
        await interaction.reply({ content: 'This command can only be used in a server.', ephemeral: true });
        return commandError('Leveling config command used outside a guild');
    }

    if (!interaction.memberPermissions?.has(PermissionsBitField.Flags.ManageGuild)) {
        await interaction.reply({
            content: 'You need Manage Server permission to configure the leveling system.',
            ephemeral: true,
        });
        return commandError('Missing ManageGuild permission');
    }

    const existingConfig = await levelingConfigRepo.getByGuildId(interaction.guildId);
    const enabledOption = interaction.options.getBoolean('enabled');
    const channelOption = interaction.options.getChannel('channel', false);

    if (enabledOption === null && !channelOption) {
        await interaction.reply({
            content: formatLevelingConfigStatus(existingConfig),
            ephemeral: true,
        });
        return commandSuccess();
    }

    let notificationChannelId: string | undefined;
    if (channelOption) {
        const channelValidation = await validateLevelingNotificationChannel(interaction.guild, channelOption.id);
        if (!channelValidation.ok) {
            await interaction.reply({ content: channelValidation.userMessage, ephemeral: true });
            return commandError(channelValidation.logMessage);
        }

        notificationChannelId = channelValidation.channelId;
    }

    try {
        const savedConfig = await levelingConfigRepo.upsertGuildSettings({
            guildId: interaction.guildId,
            enabled: enabledOption ?? existingConfig?.enabled ?? true,
            notificationChannelId,
        });

        await interaction.reply({
            content: `✅ Leveling configuration updated.\n\n${formatLevelingConfigStatus(savedConfig)}`,
            ephemeral: true,
        });

        return commandSuccess();
    } catch (error) {
        console.error('Error saving leveling configuration:', error);
        await interaction.reply({
            content: '❌ Failed to save leveling configuration. Please try again.',
            ephemeral: true,
        });
        return commandError('Failed to save leveling configuration');
    }
}

function formatLevelingConfigStatus(config: LevelingConfig | null): string {
    if (!config) {
        return (
            'Leveling is not configured yet.\n\n' +
            'Use `/leveling-config enabled:true` to turn it on. Add `channel:#your-channel` when you want level-up announcements.'
        );
    }

    const channelLine = config.notificationChannelId
        ? `**Notification channel:** <#${config.notificationChannelId}>`
        : '**Notification channel:** none (level-up announcements disabled)';

    return [`**Leveling:** ${config.enabled ? 'enabled' : 'disabled'}`, channelLine].join('\n');
}
