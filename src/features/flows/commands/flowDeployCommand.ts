import {
    ChannelType,
    ChatInputCommandInteraction,
    PermissionsBitField,
    SlashCommandBuilder,
    TextChannel,
} from 'discord.js';
import { commandError, commandSuccess } from '../../../features-system/commands';
import type { InteractionHandlerResult } from '../../../features-system/commands/types';
import { deployFlowButtons } from '../logic/deployFlowButtons';

export const flowDeployCommand = new SlashCommandBuilder()
    .setName('flow-deploy')
    .setDescription('Post a flow\'s trigger button(s) to a channel')
    .addStringOption((option) =>
        option.setName('flow-id').setDescription('The flow id to deploy').setRequired(true)
    )
    .addChannelOption((option) =>
        option
            .setName('channel')
            .setDescription('Channel to post the button in (defaults to the current channel)')
            .addChannelTypes(ChannelType.GuildText)
            .setRequired(false)
    )
    .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild);

export async function handleFlowDeployCommand(
    interaction: ChatInputCommandInteraction
): Promise<InteractionHandlerResult> {
    if (!interaction.guild) {
        await interaction.reply({ content: '❌ This command can only be used in a server.', ephemeral: true });
        return commandError('Not in guild');
    }

    if (!interaction.memberPermissions?.has('ManageGuild')) {
        await interaction.reply({
            content: '❌ You need Manage Server permissions to deploy flows.',
            ephemeral: true,
        });
        return commandError('Insufficient permissions');
    }

    const flowId = interaction.options.getString('flow-id', true);
    const targetChannel =
        (interaction.options.getChannel('channel') as TextChannel | null) ??
        (interaction.channel as TextChannel | null);

    if (!targetChannel || targetChannel.type !== ChannelType.GuildText) {
        await interaction.reply({
            content: '❌ Please specify a valid text channel or run this in one.',
            ephemeral: true,
        });
        return commandError('Invalid channel');
    }

    // Same validate-and-post path the web deploy route uses.
    const result = await deployFlowButtons(interaction.guild.id, flowId, targetChannel.id);
    if (!result.ok) {
        await interaction.reply({ content: `❌ ${result.message}`, ephemeral: true });
        return commandError(result.message);
    }

    await interaction.reply({
        content: `✅ Deployed ${result.buttonCount} button(s) for **${result.flow.name}** in ${result.channel}.`,
        ephemeral: true,
    });

    return commandSuccess('Flow deployed');
}
