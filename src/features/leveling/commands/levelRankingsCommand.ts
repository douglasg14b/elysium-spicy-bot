import {
    AttachmentBuilder,
    ChatInputCommandInteraction,
    GuildMember,
    SlashCommandBuilder,
} from 'discord.js';
import { commandError, commandSuccess } from '../../../features-system/commands';
import { InteractionHandlerResult } from '../../../features-system/commands/types';
import {
    DEFAULT_GUILD_RANKINGS_LIMIT,
    loadGuildLevelRankings,
} from '../logic/loadGuildLevelRankings';
import { cardAvatarUrlFromUser } from '../cards/shared/cardAvatarUrl';
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
        const resolvedMembers = new Map<string, GuildMember>();

        const rankings = await loadGuildLevelRankings({
            guildId: interaction.guildId,
            limit: DEFAULT_GUILD_RANKINGS_LIMIT,
            isCurrentMember: async (userId) => {
                const member = await interaction.guild!.members.fetch(userId).catch(() => null);
                if (member) {
                    resolvedMembers.set(userId, member);
                }

                return member != null;
            },
        });

        const members = rankings.entries.map((entry) => {
            const member = resolvedMembers.get(entry.userId)!;

            return {
                userId: entry.userId,
                displayName: member.displayName,
                avatarUrl: cardAvatarUrlFromUser(member.user, 128),
            } satisfies RankingsCardMember;
        });

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
