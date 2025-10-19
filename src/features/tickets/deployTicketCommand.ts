import {
    ChatInputCommandInteraction,
    SlashCommandBuilder,
    PermissionsBitField,
    TextChannel,
    ChannelType,
} from 'discord.js';
import { commandSuccess, commandError } from '../../features-system/commands';
import { InteractionHandlerResult } from '../../features-system/commands/types';
import { CreateModTicketChannelEmbedComponent } from './components';

export const deployTicketSystemCommand = new SlashCommandBuilder()
    .setName('deploy-ticket-system')
    .setDescription('Deploy the mod ticket system to a channel')
    .addChannelOption((option) =>
        option
            .setName('channel')
            .setDescription('Channel to deploy the ticket system to')
            .addChannelTypes(ChannelType.GuildText)
            .setRequired(false)
    )
    .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageChannels);

export async function handleDeployTicketSystem(
    interaction: ChatInputCommandInteraction
): Promise<InteractionHandlerResult> {
    if (!interaction.guild) {
        await interaction.reply({
            content: '❌ This command can only be used in a server.',
            ephemeral: true,
        });
        return commandError('Not in guild');
    }

    // Get target channel (use current channel if not specified)
    const targetChannel =
        (interaction.options.getChannel('channel') as TextChannel) || (interaction.channel as TextChannel);

    if (!targetChannel || targetChannel.type !== ChannelType.GuildText) {
        await interaction.reply({
            content: '❌ Please specify a valid text channel or use this command in a text channel.',
            ephemeral: true,
        });
        return commandError('Invalid channel');
    }

    try {
        // Send the message with the persistent button
        await targetChannel.send(CreateModTicketChannelEmbedComponent().messageEmbed);

        await interaction.reply({
            content: `✅ Mod ticket system deployed to ${targetChannel}!`,
            ephemeral: true,
        });

        return commandSuccess('Ticket system deployed');
    } catch (error) {
        console.error('Error deploying ticket system:', error);
        await interaction.reply({
            content: '❌ Failed to deploy ticket system. Please check bot permissions.',
            ephemeral: true,
        });
        return commandError('Failed to deploy');
    }
}
