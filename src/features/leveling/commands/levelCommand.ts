import { AttachmentBuilder, ChatInputCommandInteraction, SlashCommandBuilder } from 'discord.js';
import { commandError, commandSuccess } from '../../../features-system/commands';
import { InteractionHandlerResult } from '../../../features-system/commands/types';
import { buildUserLevelEmbed } from '../logic/buildUserLevelEmbed';
import { loadUserLevelProfile } from '../logic/loadUserLevelProfile';
import { cardAvatarUrlFromUser } from '../cards/shared/cardAvatarUrl';
import { renderLevelCard } from '../cards/levelCard/renderLevelCard';

export const LEVEL_COMMAND_NAME = 'level';

export const levelCommand = new SlashCommandBuilder()
    .setName(LEVEL_COMMAND_NAME)
    .setDescription('View leveling progress for a member')
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

    await interaction.deferReply({ ephemeral: true });

    try {
        const profile = await loadUserLevelProfile(interaction.guildId, targetUser.id);

        try {
            const cardPng = await renderLevelCard({
                profile,
                displayName: targetUser.displayName,
                avatarUrl: cardAvatarUrlFromUser(targetUser),
            });
            const attachment = new AttachmentBuilder(cardPng, { name: 'level-card.png' });

            await interaction.editReply({ files: [attachment] });
            return commandSuccess();
        } catch (cardError) {
            console.error('[leveling] Level card render failed, falling back to embed:', cardError);

            const embed = buildUserLevelEmbed(profile, targetUser);
            await interaction.editReply({ embeds: [embed] });
            return commandSuccess();
        }
    } catch (error) {
        console.error('[leveling] Error handling level command:', error);

        await interaction.editReply({
            content: 'Something went wrong while loading leveling stats.',
        });

        return commandError(error instanceof Error ? error.message : 'Unknown error');
    }
}
