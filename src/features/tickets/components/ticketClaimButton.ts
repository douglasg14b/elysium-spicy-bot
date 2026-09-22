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
import { ticketIdentityFromMember } from '../logic/resolveTicketIdentity';
import { claimTicket } from '../ticketService';
import { InteractionHandlerResult } from '../../../features-system/commands/types';

export const TICKET_CLAIM_BUTTON_ID = TICKET_BUTTON_CONFIGS.CLAIM.customId;

export function TicketClaimButtonComponent() {
    function buildComponent(enabled: boolean) {
        const button = new ButtonBuilder()
            .setCustomId(TICKET_BUTTON_CONFIGS.CLAIM.customId)
            .setLabel(TICKET_BUTTON_CONFIGS.CLAIM.label)
            .setStyle(TICKET_BUTTON_CONFIGS.CLAIM.style)
            .setEmoji(TICKET_BUTTON_CONFIGS.CLAIM.emoji)
            .setDisabled(!enabled);

        return button as ComponentBuilder<APIButtonComponentWithCustomId>;
    }

    /**
     * Claims the ticket this channel belongs to.
     *
     * The eligibility rules — already claimed, claimed by you, not open — belong
     * to `claimTicket` and are not repeated here. This handler's job is the
     * Discord half: acknowledge, apply the channel arrangement the new state
     * calls for, and re-render the message so its buttons match the record.
     */
    async function handler(interaction: ButtonInteraction): Promise<InteractionHandlerResult> {
        const resolved = await resolveTicketAction(interaction, 'claim tickets');
        if (!resolved.ok) return replyTicketFailure(interaction, ticketErrorMessage(resolved.error));
        const { guild, member, channel, config, ticket, definition } = resolved.value;

        await interaction.deferUpdate();

        // The claimer's names travel into the same guarded UPDATE as their id, so
        // the losing side of a race cannot stamp its name on the winner's claim.
        // No fetch: the acting member is already in hand.
        const result = await claimTicket(ticket.id, member.id, ticketIdentityFromMember(member));
        if (!result.ok) return replyTicketFailure(interaction, `❌ ${ticketErrorMessage(result.error)}`);
        const updated = result.value;

        const syncResult = await syncTicketChannelToState(channel, guild, updated, config);
        if (!syncResult.ok) {
            console.error('Error syncing ticket channel after claim:', syncResult.error);
            await replyTicketFailure(
                interaction,
                '⚠️ The ticket was claimed, but its channel could not be moved or re-permissioned. Check the category and permissions.'
            );
        }

        await interaction.message.edit({
            embeds: [buildTicketEmbed(updated, definition)],
            components: buildTicketButtons(updated),
        });

        await channel.send(`✋ **Ticket Claimed**\nThis ticket has been claimed by ${member}.`);

        return { status: 'success' };
    }

    return {
        handler,
        component: buildComponent,
        interactionId: TICKET_CLAIM_BUTTON_ID,
    };
}
