import {
    APIButtonComponentWithCustomId,
    ButtonBuilder,
    ButtonInteraction,
    ComponentBuilder,
} from 'discord.js';
import { TICKET_BUTTON_CONFIGS } from '../logic/ticketButtonConfigs';
import { resolveTicketAction } from '../logic/resolveTicketAction';
import { replyTicketFailure, ticketErrorMessage } from '../logic/ticketErrorMessage';
import { syncTicketChannelToState } from '../logic/ticketChannelOps';
import { buildTicketButtons, buildTicketEmbed } from '../logic/ticketPresentation';
import { closeTicket } from '../ticketService';
import { InteractionHandlerResult } from '../../../features-system/commands/types';

export const TICKET_CLOSE_BUTTON_ID = TICKET_BUTTON_CONFIGS.CLOSE.customId;

export function TicketCloseButtonComponent() {
    function buildComponent(enabled: boolean) {
        const button = new ButtonBuilder()
            .setCustomId(TICKET_BUTTON_CONFIGS.CLOSE.customId)
            .setLabel(TICKET_BUTTON_CONFIGS.CLOSE.label)
            .setStyle(TICKET_BUTTON_CONFIGS.CLOSE.style)
            .setEmoji(TICKET_BUTTON_CONFIGS.CLOSE.emoji)
            .setDisabled(!enabled);

        return button as ComponentBuilder<APIButtonComponentWithCustomId>;
    }

    /**
     * Closes the ticket this channel belongs to.
     *
     * Closing keeps the claim — who handled it is a fact about a finished ticket
     * — and the channel move plus the subject losing access both fall out of
     * `syncTicketChannelToState` reading the new status.
     */
    async function handler(interaction: ButtonInteraction): Promise<InteractionHandlerResult> {
        const resolved = await resolveTicketAction(interaction, 'close tickets');
        if (!resolved.ok) return replyTicketFailure(interaction, ticketErrorMessage(resolved.error));
        const { guild, member, channel, config, ticket, definition } = resolved.value;

        await interaction.deferUpdate();

        const result = await closeTicket(ticket.id);
        if (!result.ok) return replyTicketFailure(interaction, `❌ ${ticketErrorMessage(result.error)}`);
        const updated = result.value;

        // Worth saying loudly rather than only logging: this call is what removes
        // the subject's access to a closed ticket. If it failed, the record says
        // closed and the channel announces it, but the subject can still read
        // everything said from here on.
        const syncResult = await syncTicketChannelToState(channel, guild, updated, config);
        if (!syncResult.ok) {
            console.error('Error syncing ticket channel after close:', syncResult.error);
            await replyTicketFailure(
                interaction,
                '⚠️ The ticket was closed, but its channel permissions could not be updated — **the subject may still be able to read this channel.** Fix the permissions before discussing anything further here.'
            );
        }

        await interaction.message.edit({
            embeds: [buildTicketEmbed(updated, definition)],
            components: buildTicketButtons(updated),
        });

        await channel.send(`🔒 **Ticket Closed**\nThis ticket has been closed by ${member}.`);

        return { status: 'success' };
    }

    return {
        handler,
        component: buildComponent,
        interactionId: TICKET_CLOSE_BUTTON_ID,
    };
}
