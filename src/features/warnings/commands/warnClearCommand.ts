import { ChatInputCommandInteraction, PermissionsBitField, SlashCommandBuilder } from 'discord.js';
import { commandError, commandSuccess } from '../../../features-system/commands';
import type { InteractionHandlerResult } from '../../../features-system/commands/types';
import { clearGuildWarning } from '../logic/clearGuildWarning';
import { memberHasModerateMembers } from '../logic/warningPermissions';

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
            .setMaxLength(64)
    );

export async function handleWarnClearCommand(
    interaction: ChatInputCommandInteraction
): Promise<InteractionHandlerResult> {
    if (!interaction.inGuild() || !interaction.guildId) {
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
    const result = await clearGuildWarning(interaction.guildId, slug, interaction.user.id);

    if (result.status === 'not-found') {
        await interaction.reply({
            content: `No warning with slug \`${slug.trim().toLowerCase()}\` in this server. Check /warnings before you start forgiving ghosts.`,
            ephemeral: true,
        });
        return commandError('Warning slug not found');
    }

    if (result.status === 'already-cleared') {
        await interaction.reply({
            content: `\`${result.warning.slug}\` is already cleared. You already did the soft thing.`,
            ephemeral: true,
        });
        return commandSuccess();
    }

    await interaction.reply({
        content: `Wiped \`${result.warning.slug}\`. Clean slate, you softie.`,
        ephemeral: true,
    });
    return commandSuccess();
}
