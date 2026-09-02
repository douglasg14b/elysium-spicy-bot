import {
    AttachmentBuilder,
    ChatInputCommandInteraction,
    Guild,
    GuildMember,
    PermissionsBitField,
    SlashCommandBuilder,
    User,
} from 'discord.js';
import { commandError, commandSuccess } from '../../../features-system/commands';
import type { InteractionHandlerResult } from '../../../features-system/commands/types';
import { cardAvatarUrlFromUser } from '../../leveling/cards/shared/cardAvatarUrl';
import {
    departedWarningMemberDisplayName,
    renderActiveWarningsCard,
    type ActiveWarningsCardMember,
} from '../cards/activeWarningsCard/renderActiveWarningsCard';
import { loadActiveMemberWarnings, loadActiveWarningSummaries } from '../logic/loadActiveWarnings';
import { memberHasModerateMembers } from '../logic/warningPermissions';

const MEMBER_ID_FETCH_BATCH_SIZE = 100;

export const WARNINGS_COMMAND_NAME = 'warnings';

export const warningsCommand = new SlashCommandBuilder()
    .setName(WARNINGS_COMMAND_NAME)
    .setDescription("Show active warning counts, or one member's warnings")
    .setDefaultMemberPermissions(PermissionsBitField.Flags.ModerateMembers)
    .addUserOption((option) =>
        option.setName('user').setDescription('Member whose warnings to list').setRequired(false)
    );

function cardMemberFromGuildMember(userId: string, member: GuildMember | null): ActiveWarningsCardMember {
    if (!member) {
        return {
            userId,
            displayName: departedWarningMemberDisplayName(userId),
            avatarUrl: null,
        };
    }

    return {
        userId,
        displayName: member.displayName,
        avatarUrl: cardAvatarUrlFromUser(member.user, 128),
    };
}

async function resolveGuildMembers(guild: Guild, userIds: string[]): Promise<Map<string, GuildMember>> {
    const resolvedMembers = new Map<string, GuildMember>();
    if (userIds.length === 0) {
        return resolvedMembers;
    }

    for (let offset = 0; offset < userIds.length; offset += MEMBER_ID_FETCH_BATCH_SIZE) {
        const batch = userIds.slice(offset, offset + MEMBER_ID_FETCH_BATCH_SIZE);
        const fetched = await guild.members.fetch({ user: batch });
        for (const member of fetched.values()) {
            resolvedMembers.set(member.id, member);
        }
    }

    return resolvedMembers;
}

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
        const targetUser = interaction.options.getUser('user');
        const cardPng = targetUser
            ? await renderMemberWarningsCard(interaction, targetUser)
            : await renderSummaryWarningsCard(interaction);
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

async function renderSummaryWarningsCard(interaction: ChatInputCommandInteraction): Promise<Buffer> {
    const { summaries, totalWarnings, totalMembers } = await loadActiveWarningSummaries(interaction.guildId!);
    const resolvedMembers = await resolveGuildMembers(
        interaction.guild!,
        summaries.map((summary) => summary.userId)
    );

    return renderActiveWarningsCard({
        kind: 'summary',
        guildName: interaction.guild!.name,
        summaries,
        totalWarnings,
        totalMembers,
        members: summaries.map((summary) =>
            cardMemberFromGuildMember(summary.userId, resolvedMembers.get(summary.userId) ?? null)
        ),
    });
}

async function renderMemberWarningsCard(
    interaction: ChatInputCommandInteraction,
    targetUser: User
): Promise<Buffer> {
    const { warnings, totalActive } = await loadActiveMemberWarnings(interaction.guildId!, targetUser.id);
    const member = await interaction.guild!.members.fetch(targetUser.id).catch(() => null);

    return renderActiveWarningsCard({
        kind: 'member',
        memberName: member?.displayName ?? targetUser.displayName,
        entries: warnings.map((warning) => ({
            slug: warning.slug,
            rule: warning.rule,
            expiresAt: warning.expiresAt,
        })),
        totalActive,
    });
}
