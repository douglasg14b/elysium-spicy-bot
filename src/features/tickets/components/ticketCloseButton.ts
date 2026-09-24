import {
    APIButtonComponentWithCustomId,
    ButtonBuilder,
    ButtonInteraction,
    ComponentBuilder,
} from 'discord.js';
import { TICKET_BUTTON_CONFIGS } from '../logic/ticketButtonConfigs';
import { resolveTicketAction } from '../logic/resolveTicketAction';
import { replyTicketFailure, ticketErrorMessage } from '../logic/ticketErrorMessage';
import { applyTicketTransition } from '../logic/applyTicketTransition';
import { ticketIdentityFromMember } from '../logic/resolveTicketIdentity';
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
     * Closing keeps the claim — who handled it is a fact about a finished ticket — and
     * the channel move plus the subject losing access both fall out of the
     * orchestration syncing the channel to the new status.
     *
     * Worth knowing where the loud warning went: the sync failure on *close* is the
     * one that says the subject can still read the channel, and it is now
     * `applyTicketTransition`'s per-transition copy rather than this handler's string.
     * It is still surfaced here, because this is the surface with a member to tell.
     */
    async function handler(interaction: ButtonInteraction): Promise<InteractionHandlerResult> {
        const resolved = await resolveTicketAction(interaction, 'close tickets');
        if (!resolved.ok) return replyTicketFailure(interaction, ticketErrorMessage(resolved.error));
        const { guild, member, config, ticket, definition } = resolved.value;

        await interaction.deferUpdate();

        const result = await applyTicketTransition({
            guild,
            config,
            ticket,
            definition,
            transition: 'close',
            actor: { id: member.id, mention: member.toString(), identity: ticketIdentityFromMember(member) },
            message: interaction.message,
        });

        if (!result.ok) return replyTicketFailure(interaction, `❌ ${result.message}`);
        if (result.outcome.syncWarning) {
            await replyTicketFailure(interaction, result.outcome.syncWarning);
        }

        return { status: 'success' };
    }

    return {
        handler,
        component: buildComponent,
        interactionId: TICKET_CLOSE_BUTTON_ID,
    };
}
