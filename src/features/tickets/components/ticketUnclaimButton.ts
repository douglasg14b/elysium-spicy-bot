import {
    APIButtonComponentWithCustomId,
    ButtonBuilder,
    ButtonInteraction,
    ComponentBuilder,
} from 'discord.js';
import { memberHasModeratorPerms, memberHasModeratorRole } from '../logic/hasModeratorRole';
import { TICKET_BUTTON_CONFIGS } from '../logic/ticketButtonConfigs';
import { resolveTicketAction } from '../logic/resolveTicketAction';
import { replyTicketFailure, ticketErrorMessage } from '../logic/ticketErrorMessage';
import { syncTicketChannelToState } from '../logic/ticketChannelOps';
import { buildTicketButtons, buildTicketEmbed } from '../logic/ticketPresentation';
import { unclaimTicket } from '../ticketService';
import { InteractionHandlerResult } from '../../../features-system/commands/types';

export const TICKET_UNCLAIM_BUTTON_ID = TICKET_BUTTON_CONFIGS.UNCLAIM.customId;

export function TicketUnclaimButtonComponent() {
    function buildComponent(enabled: boolean) {
        const button = new ButtonBuilder()
            .setCustomId(TICKET_BUTTON_CONFIGS.UNCLAIM.customId)
            .setLabel(TICKET_BUTTON_CONFIGS.UNCLAIM.label)
            .setStyle(TICKET_BUTTON_CONFIGS.UNCLAIM.style)
            .setEmoji(TICKET_BUTTON_CONFIGS.UNCLAIM.emoji)
            .setDisabled(!enabled);

        return button as ComponentBuilder<APIButtonComponentWithCustomId>;
    }

    /**
     * Releases the claim on this channel's ticket.
     *
     * Carries one rule the service cannot: *who* may release a claim. The
     * service knows only that a claim exists, so the "yours, or you outrank the
     * person holding it" check stays here, where the acting member is known.
     * Whether the ticket is claimed at all is left to `unclaimTicket`.
     */
    async function handler(interaction: ButtonInteraction): Promise<InteractionHandlerResult> {
        const resolved = await resolveTicketAction(interaction, 'unclaim tickets');
        if (!resolved.ok) return replyTicketFailure(interaction, ticketErrorMessage(resolved.error));
        const { guild, member, channel, config, ticket } = resolved.value;

        // Same disjunction the gate uses, deliberately. Testing only
        // `memberHasModeratorPerms` here would be near-vacuous — the gate has
        // already required role *or* perms — while still denying a holder of a
        // configured moderation role without native `ModerateMembers`, who may
        // claim and close but would be refused the release.
        const isModerator = memberHasModeratorRole(member, config.moderationRoles) || memberHasModeratorPerms(member);
        if (ticket.claimerId !== member.id && !isModerator) {
            return replyTicketFailure(interaction, '❌ You can only unclaim tickets you have claimed.');
        }

        await interaction.deferUpdate();

        const result = await unclaimTicket(ticket.id);
        if (!result.ok) return replyTicketFailure(interaction, `❌ ${ticketErrorMessage(result.error)}`);
        const updated = result.value;

        const syncResult = await syncTicketChannelToState(channel, guild, updated, config);
        if (!syncResult.ok) {
            console.error('Error syncing ticket channel after unclaim:', syncResult.error);
            await replyTicketFailure(
                interaction,
                '⚠️ The ticket was released, but its channel could not be moved or re-permissioned. Check the category and permissions.'
            );
        }

        await interaction.message.edit({
            embeds: [buildTicketEmbed(updated)],
            components: buildTicketButtons(updated),
        });

        await channel.send(`↩️ **Ticket Released**\nThis ticket has been released by ${member} and is up for grabs.`);

        return { status: 'success' };
    }

    return {
        handler,
        component: buildComponent,
        interactionId: TICKET_UNCLAIM_BUTTON_ID,
    };
}
