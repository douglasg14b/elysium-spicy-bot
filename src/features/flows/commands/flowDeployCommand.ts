import {
    ChatInputCommandInteraction,
    PermissionsBitField,
    SlashCommandBuilder,
} from 'discord.js';
import { commandError, commandSuccess } from '../../../features-system/commands';
import type { InteractionHandlerResult } from '../../../features-system/commands/types';
import { deployFlowButtons } from '../logic/deployFlowButtons';

/*
 * No `channel` option any more: each button trigger names the channel it belongs in,
 * so one here could only override every button with a single destination — which is
 * precisely the flow-scoped behaviour this was changed away from. The destination is
 * authoring data now, and it lives on the canvas.
 */
export const flowDeployCommand = new SlashCommandBuilder()
    .setName('flow-deploy')
    .setDescription('Post a flow\'s trigger buttons to the channels they name')
    .addStringOption((option) =>
        option.setName('flow-id').setDescription('The flow id to deploy').setRequired(true)
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

    /*
     * Deferred before the work, not after.
     *
     * A deploy is now several Discord round trips — a guild fetch, a full retire of
     * whatever is already live (fetch and delete per recorded message), then a send
     * per destination channel. Past the three-second window `reply` fails with 10062
     * `Unknown interaction` *after* the guild has already been changed, leaving the
     * operator staring at "The application did not respond" with no idea what landed.
     */
    await interaction.deferReply({ ephemeral: true });

    // Same validate-and-post path the web deploy route uses.
    const result = await deployFlowButtons(interaction.guild.id, flowId);
    if (!result.ok) {
        await interaction.editReply({ content: `❌ ${result.message}` });
        return commandError(result.message);
    }

    const where = result.posted.map((entry) => `<#${entry.channelId}>`).join(', ');
    await interaction.editReply({
        content: `✅ Deployed ${result.buttonCount} button(s) for **${result.flow.name}** across ${where}.`,
    });

    return commandSuccess('Flow deployed');
}
