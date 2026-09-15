import {
    ActionRowBuilder,
    APIButtonComponentWithCustomId,
    ButtonBuilder,
    ButtonInteraction,
    ComponentBuilder,
    EmbedBuilder,
} from 'discord.js';
import { TICKET_BUTTON_CONFIGS } from '../logic/ticketButtonConfigs';
import { resolveTicketAction } from '../logic/resolveTicketAction';
import { replyTicketFailure, ticketErrorMessage } from '../logic/ticketErrorMessage';
import { deleteTicket } from '../ticketService';
import { InteractionHandlerResult } from '../../../features-system/commands/types';

export const TICKET_DELETE_BUTTON_ID = TICKET_BUTTON_CONFIGS.DELETE.customId;
export const TICKET_CONFIRM_DELETE_BUTTON_ID = TICKET_BUTTON_CONFIGS.CONFIRM_DELETE.customId;

export function TicketDeleteButtonComponent() {
    function buildComponent(enabled: boolean) {
        const button = new ButtonBuilder()
            .setCustomId(TICKET_DELETE_BUTTON_ID)
            .setLabel(TICKET_BUTTON_CONFIGS.DELETE.label)
            .setStyle(TICKET_BUTTON_CONFIGS.DELETE.style)
            .setEmoji(TICKET_BUTTON_CONFIGS.DELETE.emoji)
            .setDisabled(!enabled);

        return button as ComponentBuilder<APIButtonComponentWithCustomId>;
    }

    /**
     * First half of the two-step delete: asks for confirmation.
     *
     * Resolves the ticket here purely so an unauthorised press or a non-ticket
     * channel is refused before anyone is offered a destructive button. Nothing
     * is changed at this step.
     */
    async function handler(interaction: ButtonInteraction): Promise<InteractionHandlerResult> {
        const resolved = await resolveTicketAction(interaction, 'delete tickets');
        if (!resolved.ok) return replyTicketFailure(interaction, ticketErrorMessage(resolved.error));
        const { ticket } = resolved.value;

        const confirmDeleteButton = new ButtonBuilder()
            .setCustomId(TICKET_CONFIRM_DELETE_BUTTON_ID)
            .setLabel(TICKET_BUTTON_CONFIGS.CONFIRM_DELETE.label)
            .setStyle(TICKET_BUTTON_CONFIGS.CONFIRM_DELETE.style)
            .setEmoji(TICKET_BUTTON_CONFIGS.CONFIRM_DELETE.emoji);
        const components = [new ActionRowBuilder<ButtonBuilder>().addComponents(confirmDeleteButton)];

        const confirmationEmbed = new EmbedBuilder()
            .setTitle('⚠️ Confirm Ticket Deletion')
            .setDescription(
                `You are about to permanently delete **Ticket #${ticket.ticketNumber}** and its channel.\n\nClick **${TICKET_BUTTON_CONFIGS.CONFIRM_DELETE.label}** to continue.`
            )
            .setColor(0xff0000)
            .setTimestamp();

        await interaction.reply({
            embeds: [confirmationEmbed],
            components,
            ephemeral: true,
        });

        return { status: 'success' };
    }

    return {
        handler,
        component: buildComponent,
        interactionId: TICKET_DELETE_BUTTON_ID,
    };
}

/**
 * Replaces the "Deleting ticket…" placeholder with the reason it did not happen.
 *
 * `editReply` rather than the shared `replyTicketFailure`: this flow has already
 * called `interaction.update()`, so a `followUp` would leave that placeholder
 * standing and add a second ephemeral beneath it — the member would be told the
 * delete both succeeded and failed. The ephemeral is private to the presser and
 * survives the channel's removal, which the channel itself does not.
 */
async function editDeleteFailure(
    interaction: ButtonInteraction,
    message: string
): Promise<InteractionHandlerResult> {
    try {
        await interaction.editReply({ content: message, embeds: [], components: [] });
    } catch (error) {
        console.error('Failed to deliver ticket delete failure message:', error);
    }

    return { status: 'error', message };
}

export function TicketConfirmDeleteButtonComponent() {
    function buildComponent(enabled: boolean) {
        const button = new ButtonBuilder()
            .setCustomId(TICKET_CONFIRM_DELETE_BUTTON_ID)
            .setLabel(TICKET_BUTTON_CONFIGS.CONFIRM_DELETE.label)
            .setStyle(TICKET_BUTTON_CONFIGS.CONFIRM_DELETE.style)
            .setEmoji(TICKET_BUTTON_CONFIGS.CONFIRM_DELETE.emoji)
            .setDisabled(!enabled);

        return button as ComponentBuilder<APIButtonComponentWithCustomId>;
    }

    /**
     * Second half of the delete: marks the record deleted, then removes the channel.
     *
     * The order is the point. `deleteTicket` marks the row and clears its
     * `channelId`, so if it fails the channel is still standing and this button
     * can be pressed again. Deleting the channel first and then failing the
     * update would leave a row pointing at a channel that no longer exists —
     * unrecoverable through the UI, because the UI is reached *through* that
     * channel.
     *
     * The window that remains is the inverse and it is not retryable: once the
     * row is marked deleted, `getByChannelId` filters it out, so a failed channel
     * deletion cannot be resolved by pressing the button again. That is precisely
     * why the failure below has to reach a human instead of only the log.
     *
     * Feedback goes to the ephemeral via `editReply` — after the channel is gone
     * there is nothing there to post to, and the interaction is already replied.
     */
    async function handler(interaction: ButtonInteraction): Promise<InteractionHandlerResult> {
        const resolved = await resolveTicketAction(interaction, 'delete tickets');
        if (!resolved.ok) return replyTicketFailure(interaction, ticketErrorMessage(resolved.error));
        const { channel, ticket } = resolved.value;

        await interaction.update({
            content: '🗑️ Deleting ticket...',
            embeds: [],
            components: [],
        });

        const result = await deleteTicket(ticket.id);
        if (!result.ok) return editDeleteFailure(interaction, `❌ ${ticketErrorMessage(result.error)}`);

        try {
            await channel.delete(`Ticket #${ticket.ticketNumber} deleted by ${interaction.user.tag}`);
        } catch (error) {
            console.error('Error deleting ticket channel after confirmation:', error);
            return editDeleteFailure(
                interaction,
                `❌ Ticket #${ticket.ticketNumber} was marked deleted, but its channel could not be removed. **Delete this channel manually** — the button will not work a second time.`
            );
        }

        return { status: 'success' };
    }

    return {
        handler,
        component: buildComponent,
        interactionId: TICKET_CONFIRM_DELETE_BUTTON_ID,
    };
}
