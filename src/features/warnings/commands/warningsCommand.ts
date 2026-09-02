import {
    AttachmentBuilder,
    ChatInputCommandInteraction,
    GuildMember,
    PermissionsBitField,
    SlashCommandBuilder,
} from 'discord.js';
import { commandError, commandSuccess } from '../../../features-system/commands';
import type { InteractionHandlerResult } from '../../../features-system/commands/types';
import { cardAvatarUrlFromUser } from '../../leveling/cards/shared/cardAvatarUrl';
import {
    renderActiveWarningsCard,
    type ActiveWarningsCardMember,
} from '../cards/activeWarningsCard/renderActiveWarningsCard';
import { loadActiveGuildWarnings } from '../logic/loadActiveGuildWarnings';
import { memberHasModerateMembers } from '../logic/warningPermissions';

export const WARNINGS_COMMAND_NAME = 'warnings';

export const warningsCommand = new SlashCommandBuilder()
    .setName(WARNINGS_COMMAND_NAME)
    .setDescription('Show active staff warnings in this server')
    .setDefaultMemberPermissions(PermissionsBitField.Flags.ModerateMembers);

export async function handleWarningsCommand(
    interaction: ChatInputCommandInteraction
): Promise<InteractionHandlerResult> {
    if (!interaction.inGuild() || !interaction.guildId || !interaction.guild) {
        await interaction.reply({ content: 'This command can only be used in a server.', ephemeral: true });
        return commandError('Warnings command used outside a guild');
    }

    if (!memberHasModerateMembers(interaction.memberPermissions)) {
        await interaction.reply({
            content: 'Cute try, but you need Moderate Members to peek at the naughty list.',
            ephemeral: true,
        });
        return commandError('Missing ModerateMembers permission');
    }

    await interaction.deferReply({ ephemeral: true });

    try {
        const { warnings, totalActive } = await loadActiveGuildWarnings(interaction.guildId);

        const uniqueUserIds = [...new Set(warnings.map((warning) => warning.userId))];
        const resolvedMembers = new Map<string, GuildMember>();
        await Promise.all(
            uniqueUserIds.map(async (userId) => {
                const member = await interaction.guild!.members.fetch(userId).catch(() => null);
                if (member) {
                    resolvedMembers.set(userId, member);
                }
            })
        );

        const members: ActiveWarningsCardMember[] = warnings.map((warning) => {
            const member = resolvedMembers.get(warning.userId);

            return {
                userId: warning.userId,
                displayName: member?.displayName ?? `Left server (${warning.userId.slice(-4)})`,
                avatarUrl: member ? cardAvatarUrlFromUser(member.user, 128) : null,
            };
        });

        const cardPng = await renderActiveWarningsCard({
            guildName: interaction.guild.name,
            entries: warnings.map((warning) => ({
                slug: warning.slug,
                userId: warning.userId,
                rule: warning.rule,
                expiresAt: warning.expiresAt,
            })),
            members,
            totalActive,
        });
        const attachment = new AttachmentBuilder(cardPng, { name: 'active-warnings.png' });

        await interaction.editReply({ files: [attachment] });
        return commandSuccess();
    } catch (error) {
        console.error('[warnings] Error handling warnings command:', error);

        await interaction.editReply({
            content: 'Something went sideways while loading active warnings.',
        });

        return commandError(error instanceof Error ? error.message : 'Unknown error');
    }
}
