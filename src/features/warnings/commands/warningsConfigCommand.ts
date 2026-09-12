import { ChatInputCommandInteraction, PermissionsBitField, SlashCommandBuilder } from 'discord.js';
import { commandError, commandSkipped } from '../../../features-system/commands';
import type { InteractionHandlerResult } from '../../../features-system/commands/types';
import { warningsConfigRepo } from '../data/warningsConfigRepo';
import { WarningsConfigModalComponent } from '../components/warningsConfigModal';

export const WARNINGS_CONFIG_COMMAND_NAME = 'warnings-config';

export const warningsConfigCommand = new SlashCommandBuilder()
    .setName(WARNINGS_CONFIG_COMMAND_NAME)
    .setDescription('Configure the staff channel that receives warning notices')
    .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild);

export async function handleWarningsConfigCommand(
    interaction: ChatInputCommandInteraction
): Promise<InteractionHandlerResult> {
    if (!interaction.inGuild() || !interaction.guildId || !interaction.guild) {
        await interaction.reply({ content: 'This command can only be used in a server.', ephemeral: true });
        return commandError('Warnings config command used outside a guild');
    }

    if (!interaction.memberPermissions?.has(PermissionsBitField.Flags.ManageGuild)) {
        await interaction.reply({
            content: 'You need Manage Server to pick where warning notices go.',
            ephemeral: true,
        });
        return commandError('Missing ManageGuild permission');
    }

    try {
        const existingConfig = await warningsConfigRepo.getByGuildId(interaction.guildId);
        const modal = WarningsConfigModalComponent().buildComponent(existingConfig?.modChannelId);

        await interaction.showModal(modal);
        return commandSkipped();
    } catch (error) {
        console.error('[warnings] Error showing warnings config modal:', error);
        await interaction.reply({
            content: 'Could not open the warnings config modal. Try again in a second.',
            ephemeral: true,
        });
        return commandError('Failed to open warnings config modal');
    }
}
