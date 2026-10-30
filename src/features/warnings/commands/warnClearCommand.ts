import { ChatInputCommandInteraction, PermissionsBitField, SlashCommandBuilder } from 'discord.js';
import { commandError, commandSuccess } from '../../../features-system/commands';
import type { InteractionHandlerResult } from '../../../features-system/commands/types';
import { WARN_RELEASE_REASON_MAX_LENGTH, WARNING_SLUG_INPUT_MAX_LENGTH } from '../constants';
import { clearGuildWarning } from '../logic/clearGuildWarning';
import { notifyWarningReleased } from '../logic/warningChangeNotices';
import { warningNoticeNote } from '../logic/warningNotice';
import { memberHasModerateMembers } from '../logic/warningPermissions';
import { alreadyReleasedSentence, EMPTY_RELEASE_REASON_SENTENCE, releaseNotFoundSentence } from '../logic/warningRefusals';
import { normalizeWarningSlug } from '../logic/warningSlug';
import { memberDisplayName } from '../utils/memberDisplayName';

export const WARN_CLEAR_COMMAND_NAME = 'warn-clear';

export const warnClearCommand = new SlashCommandBuilder()
    .setName(WARN_CLEAR_COMMAND_NAME)
    .setDescription('Clear a specific staff warning by slug')
    .setDefaultMemberPermissions(PermissionsBitField.Flags.ModerateMembers)
    .addStringOption((option) =>
        option
            .setName('slug')
            .setDescription('Warning slug from /warnings or the issue confirmation')
            .setRequired(true)
            .setMaxLength(WARNING_SLUG_INPUT_MAX_LENGTH)
    )
    .addStringOption((option) =>
        option
            .setName('reason')
            .setDescription('Why they are off the hook. Kept on the record.')
            .setRequired(true)
            .setMinLength(1)
            .setMaxLength(WARN_RELEASE_REASON_MAX_LENGTH)
    );

export async function handleWarnClearCommand(
    interaction: ChatInputCommandInteraction
): Promise<InteractionHandlerResult> {
    if (!interaction.inGuild() || !interaction.guildId || !interaction.guild) {
        await interaction.reply({ content: 'This command can only be used in a server.', ephemeral: true });
        return commandError('Warn-clear command used outside a guild');
    }

    if (!memberHasModerateMembers(interaction.memberPermissions)) {
        await interaction.reply({
            content: 'Cute try, but you need Moderate Members to wipe warnings.',
            ephemeral: true,
        });
        return commandError('Missing ModerateMembers permission');
    }

    const slug = interaction.options.getString('slug', true);
    const reason = interaction.options.getString('reason', true);
    const releasedBy = { id: interaction.user.id, name: memberDisplayName(interaction.member, interaction.user) };

    // Deferred before the write: the release notice is a Discord call of its own.
    await interaction.deferReply({ ephemeral: true });

    try {
        const result = await clearGuildWarning(interaction.guildId, slug, releasedBy, reason);

        switch (result.status) {
            case 'not-found':
                await interaction.editReply({ content: releaseNotFoundSentence(normalizeWarningSlug(slug), 'discord') });
                return commandError('Warning slug not found');
            case 'empty-reason':
                await interaction.editReply({ content: EMPTY_RELEASE_REASON_SENTENCE });
                return commandError('Release reason was blank');
            case 'already-cleared':
                await interaction.editReply({ content: alreadyReleasedSentence(result.warning.slug) });
                return commandSuccess();
            case 'cleared': {
                const noticeStatus = await notifyWarningReleased(interaction.guild, result.warning);
                const wiped = `Wiped \`${result.warning.slug}\`. Clean slate, you softie.`;
                const note = warningNoticeNote(noticeStatus, { command: WARN_CLEAR_COMMAND_NAME, saved: 'Release' });

                await interaction.editReply({ content: note ? `${wiped}\n${note}` : wiped });
                return commandSuccess();
            }
        }
    } catch (error) {
        console.error('[warnings] Failed to release warning:', error);

        await interaction.editReply({
            content: 'Could not release that warning. Check /warnings before you try again.',
        });

        return commandError(error instanceof Error ? error.message : 'Unknown error');
    }
}
