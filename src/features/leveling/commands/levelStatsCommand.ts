import { AttachmentBuilder, ChatInputCommandInteraction, SlashCommandBuilder } from 'discord.js';
import { commandError, commandSuccess } from '../../../features-system/commands';
import { InteractionHandlerResult } from '../../../features-system/commands/types';
import { loadUserLevelStats } from '../logic/loadUserLevelStats';
import { renderStatsCard } from '../cards/statsCard/renderStatsCard';

export const LEVEL_STATS_COMMAND_NAME = 'level-stats';

export const levelStatsCommand = new SlashCommandBuilder()
    .setName(LEVEL_STATS_COMMAND_NAME)
    .setDescription('View leveling activity stats for a member')
    .addUserOption((option) =>
        option.setName('user').setDescription('Member to inspect (defaults to you)').setRequired(false)
    );

export async function handleLevelStatsCommand(
    interaction: ChatInputCommandInteraction
): Promise<InteractionHandlerResult> {
    if (!interaction.inGuild() || !interaction.guildId) {
        await interaction.reply({ content: 'This command can only be used in a server.', ephemeral: true });
        return commandError('Level stats command used outside a guild');
    }

    const targetUser = interaction.options.getUser('user') ?? interaction.user;

    await interaction.deferReply({ ephemeral: true });

    try {
        const stats = await loadUserLevelStats(interaction.guildId, targetUser.id);
        const cardPng = await renderStatsCard({
            ...stats,
            displayName: targetUser.displayName,
            avatarUrl: targetUser.displayAvatarURL({ size: 256 }),
        });
        const attachment = new AttachmentBuilder(cardPng, { name: 'stats-card.png' });

        await interaction.editReply({ files: [attachment] });
        return commandSuccess();
    } catch (error) {
        console.error('[leveling] Error handling level-stats command:', error);

        await interaction.editReply({
            content: 'Something went wrong while loading leveling stats.',
        });

        return commandError(error instanceof Error ? error.message : 'Unknown error');
    }
}
