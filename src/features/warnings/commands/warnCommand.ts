import { ChatInputCommandInteraction, PermissionsBitField, SlashCommandBuilder } from 'discord.js';
import { commandError, commandSkipped } from '../../../features-system/commands';
import type { InteractionHandlerResult } from '../../../features-system/commands/types';
import { WarnModalComponent } from '../components/warnModal';
import { memberHasModerateMembers } from '../logic/warningPermissions';

export const WARN_COMMAND_NAME = 'warn';

export const warnCommand = new SlashCommandBuilder()
    .setName(WARN_COMMAND_NAME)
    .setDescription('Issue a staff warning to a member')
    .setDefaultMemberPermissions(PermissionsBitField.Flags.ModerateMembers);

export async function handleWarnCommand(
    interaction: ChatInputCommandInteraction
): Promise<InteractionHandlerResult> {
    if (!interaction.inGuild() || !interaction.guildId) {
        await interaction.reply({ content: 'This command can only be used in a server.', ephemeral: true });
        return commandError('Warn command used outside a guild');
    }

    if (!memberHasModerateMembers(interaction.memberPermissions)) {
        await interaction.reply({
            content: 'Cute try, but you need Moderate Members to hand out warnings.',
            ephemeral: true,
        });
        return commandError('Missing ModerateMembers permission');
    }

    const modal = WarnModalComponent().buildComponent();
    await interaction.showModal(modal);
    return commandSkipped();
}
