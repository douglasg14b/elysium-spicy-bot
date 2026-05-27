import { AttachmentBuilder, ChatInputCommandInteraction, SlashCommandBuilder } from 'discord.js';
import { commandError, commandSuccess } from '../../../features-system/commands';
import { InteractionHandlerResult } from '../../../features-system/commands/types';
import {
    DEFAULT_GUILD_RANKINGS_LIMIT,
    loadGuildLevelRankings,
} from '../logic/loadGuildLevelRankings';
import { renderRankingsCard, type RankingsCardMember } from '../cards/rankingsCard/renderRankingsCard';

export const LEVEL_RANKINGS_COMMAND_NAME = 'level-rankings';

export const levelRankingsCommand = new SlashCommandBuilder()
    .setName(LEVEL_RANKINGS_COMMAND_NAME)
    .setDescription('Moderator overview of top members by total XP');

export async function handleLevelRankingsCommand(
    interaction: ChatInputCommandInteraction
): Promise<InteractionHandlerResult> {
    if (!interaction.inGuild() || !interaction.guildId || !interaction.guild) {
        await interaction.reply({ content: 'This command can only be used in a server.', ephemeral: true });
        return commandError('Level rankings command used outside a guild');
    }

    await interaction.deferReply({ ephemeral: true });

    try {
        const rankings = await loadGuildLevelRankings({
            guildId: interaction.guildId,
            limit: DEFAULT_GUILD_RANKINGS_LIMIT,
        });

        const members = await resolveRankingsMembers(
            interaction.guild.members,
            rankings.entries.map((entry) => entry.userId)
        );

        const cardPng = await renderRankingsCard({
            guildName: interaction.guild.name,
            rankings,
            members,
        });
        const attachment = new AttachmentBuilder(cardPng, { name: 'rankings-card.png' });

        await interaction.editReply({ files: [attachment] });
        return commandSuccess();
    } catch (error) {
        console.error('[leveling] Error handling level-rankings command:', error);

        await interaction.editReply({
            content: 'Something went wrong while loading the server rankings.',
        });

        return commandError(error instanceof Error ? error.message : 'Unknown error');
    }
}

async function resolveRankingsMembers(
    guildMembers: ChatInputCommandInteraction['guild']['members'],
    userIds: readonly string[]
): Promise<RankingsCardMember[]> {
    if (!guildMembers) {
        return userIds.map((userId) => ({
            userId,
            displayName: `Member ${userId.slice(-4)}`,
            avatarUrl: null,
        }));
    }

    return Promise.all(
        userIds.map(async (userId) => {
            const member = await guildMembers.fetch(userId).catch(() => null);

            return {
                userId,
                displayName: member?.displayName ?? `Member ${userId.slice(-4)}`,
                avatarUrl: member?.displayAvatarURL({ size: 128 }) ?? null,
            } satisfies RankingsCardMember;
        })
    );
}
