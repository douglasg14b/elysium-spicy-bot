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
import { reopenTicket } from '../ticketService';
import { InteractionHandlerResult } from '../../../features-system/commands/types';

export const TICKET_REOPEN_BUTTON_ID = TICKET_BUTTON_CONFIGS.REOPEN.customId;

export function TicketReopenButtonComponent() {
    function buildComponent(enabled: boolean) {
        const button = new ButtonBuilder()
            .setCustomId(TICKET_BUTTON_CONFIGS.REOPEN.customId)
            .setLabel(TICKET_BUTTON_CONFIGS.REOPEN.label)
            .setStyle(TICKET_BUTTON_CONFIGS.REOPEN.style)
            .setEmoji(TICKET_BUTTON_CONFIGS.REOPEN.emoji)
            .setDisabled(!enabled);

        return button as ComponentBuilder<APIButtonComponentWithCustomId>;
    }

    /**
     * Reopens a closed ticket.
     *
     * The claim survives a close/reopen round trip now, so a reopened ticket
     * returns to the claimed category if it had a claimer. The old path cleared
     * the claim on reopen, which it had to: status was a single enum where
     * "claimed" and "open" were mutually exclusive values.
     */
    async function handler(interaction: ButtonInteraction): Promise<InteractionHandlerResult> {
        const resolved = await resolveTicketAction(interaction, 'reopen tickets');
        if (!resolved.ok) return replyTicketFailure(interaction, ticketErrorMessage(resolved.error));
        const { guild, member, channel, config, ticket } = resolved.value;

        await interaction.deferUpdate();

        const result = await reopenTicket(ticket.id);
        if (!result.ok) return replyTicketFailure(interaction, `❌ ${ticketErrorMessage(result.error)}`);
        const updated = result.value;

        // The inverse of the close case: this call restores the subject's access.
        // Failing silently leaves a ticket that says it is open but which the
        // person it concerns cannot see or post in.
        const syncResult = await syncTicketChannelToState(channel, guild, updated, config);
        if (!syncResult.ok) {
            console.error('Error syncing ticket channel after reopen:', syncResult.error);
            await replyTicketFailure(
                interaction,
                '⚠️ The ticket was reopened, but its channel permissions could not be updated — the subject may still be locked out. Check the permissions.'
            );
        }

        await interaction.message.edit({
            embeds: [buildTicketEmbed(updated)],
            components: buildTicketButtons(updated),
        });

        await channel.send(`🔓 **Ticket Reopened**\nThis ticket has been reopened by ${member}.`);

        return { status: 'success' };
    }

    return {
        handler,
        component: buildComponent,
        interactionId: TICKET_REOPEN_BUTTON_ID,
    };
}
