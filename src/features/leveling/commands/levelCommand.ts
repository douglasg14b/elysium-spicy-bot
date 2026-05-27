import { ChatInputCommandInteraction, SlashCommandBuilder } from 'discord.js';
import { commandError, commandSuccess } from '../../../features-system/commands';
import { InteractionHandlerResult } from '../../../features-system/commands/types';
import { levelingActivityEventRepo } from '../data/levelingActivityEventRepo';
import { levelingProgressRepo } from '../data/levelingProgressRepo';
import { buildUserLevelEmbed } from '../logic/buildUserLevelEmbed';
import { buildUserLevelProfile, getRecentActivitySince } from '../logic/userLevelProfile';

export const LEVEL_COMMAND_NAME = 'level';

export const levelCommand = new SlashCommandBuilder()
    .setName(LEVEL_COMMAND_NAME)
    .setDescription('View leveling progress and activity for a member')
    .addUserOption((option) =>
        option.setName('user').setDescription('Member to inspect (defaults to you)').setRequired(false)
    );

export async function handleLevelCommand(
    interaction: ChatInputCommandInteraction
): Promise<InteractionHandlerResult> {
    if (!interaction.inGuild() || !interaction.guildId) {
        await interaction.reply({ content: 'This command can only be used in a server.', ephemeral: true });
        return commandError('Level command used outside a guild');
    }

    const targetUser = interaction.options.getUser('user') ?? interaction.user;
    const guildId = interaction.guildId;

    await interaction.deferReply();

    try {
        const [progress, recentActivity, totalActivity] = await Promise.all([
            levelingProgressRepo.get(guildId, targetUser.id),
            levelingActivityEventRepo.getUserActivityTotals(guildId, targetUser.id, {
                since: getRecentActivitySince(),
            }),
            levelingActivityEventRepo.getUserActivityTotals(guildId, targetUser.id),
        ]);

        const profile = buildUserLevelProfile({
            userId: targetUser.id,
            progress,
            recentActivity,
            totalActivity,
        });

        const embed = buildUserLevelEmbed(profile, targetUser);

        await interaction.editReply({ embeds: [embed] });
        return commandSuccess();
    } catch (error) {
        console.error('[leveling] Error handling level command:', error);

        await interaction.editReply({
            content: 'Something went wrong while loading leveling stats.',
        });

        return commandError(error instanceof Error ? error.message : 'Unknown error');
    }
}
