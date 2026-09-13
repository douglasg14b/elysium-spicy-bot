import { ButtonInteraction, GuildMember } from 'discord.js';
import type { InteractionHandlerResult } from '../../../features-system/commands/types';
import { flowsRepo } from '../data/flowsRepo';
import { TRIGGER_BUTTON_CLICK } from '../blocks/triggerButtonClick';
import { parseFlowCustomId } from '../utils/customId';
import { executeFlow } from './executor';
import { resumeWaitingRunsForEvent } from './waitingRunDispatch';
import type { FlowRunContext } from '../blocks/types';

/**
 * The single `flow:` catch-all message-component handler. Parses
 * `flow:<flowId>:<nodeId>`, loads the flow, confirms the node is a buttonClick
 * trigger, and runs the executor with the interacting member as context.
 *
 * A click also wakes any durable run parked on an `action.waitForEvent` node
 * awaiting a button click from this user.
 */
export async function handleFlowButtonInteraction(
    interaction: ButtonInteraction
): Promise<InteractionHandlerResult> {
    const parsed = parseFlowCustomId(interaction.customId);
    if (!parsed) {
        return { status: 'error', message: 'Malformed flow button id.' };
    }

    if (!interaction.guild || !(interaction.member instanceof GuildMember)) {
        return { status: 'error', message: '❌ This button can only be used in a server.' };
    }

    await resumeWaitingRunsForEvent(interaction.client, {
        guildId: interaction.guild.id,
        userId: interaction.user.id,
        eventKind: 'buttonClick',
    });

    const flow = await flowsRepo.getByFlowId(parsed.flowId);
    if (!flow) {
        return { status: 'error', message: 'This flow no longer exists.' };
    }
    if (!flow.enabled) {
        return { status: 'error', message: 'This flow is currently disabled.' };
    }
    if (flow.guildId !== interaction.guild.id) {
        return { status: 'error', message: 'This flow does not belong to this server.' };
    }

    const triggerNode = flow.graph.nodes.find((node) => node.id === parsed.nodeId);
    if (!triggerNode || triggerNode.type !== TRIGGER_BUTTON_CLICK) {
        return { status: 'error', message: 'This button is not wired to a valid trigger.' };
    }

    const member = interaction.member;
    const context: FlowRunContext = {
        client: interaction.client,
        guild: interaction.guild,
        member,
        user: member.user,
        interaction,
    };

    // Acknowledge quietly so the user is not left with a "failed" interaction
    // while actions run. Actions post their own visible side effects.
    if (!interaction.deferred && !interaction.replied) {
        await interaction.deferReply({ ephemeral: true });
    }

    const result = await executeFlow(flow.flowId, flow.graph, triggerNode.id, context);

    const reply =
        result.status === 'success'
            ? '✅ Done!'
            : '❌ Something went wrong running this flow. A mod has been notified in the logs.';

    if (interaction.deferred) {
        await interaction.editReply({ content: reply });
    } else if (!interaction.replied) {
        await interaction.reply({ content: reply, ephemeral: true });
    }

    return {
        status: result.status === 'success' ? 'success' : 'error',
        message: result.status === 'success' ? undefined : result.error,
    };
}
