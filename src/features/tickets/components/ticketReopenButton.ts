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
     * The claim survives a close/reopen round trip now, so a reopened ticket returns
     * to the claimed category if it had a claimer. The old path cleared the claim on
     * reopen, which it had to: status was a single enum where "claimed" and "open"
     * were mutually exclusive values.
     */
    async function handler(interaction: ButtonInteraction): Promise<InteractionHandlerResult> {
        const resolved = await resolveTicketAction(interaction, 'reopen tickets');
        if (!resolved.ok) return replyTicketFailure(interaction, ticketErrorMessage(resolved.error));
        const { guild, member, config, ticket, definition } = resolved.value;

        await interaction.deferUpdate();

        const result = await applyTicketTransition({
            guild,
            config,
            ticket,
            definition,
            transition: 'reopen',
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
        interactionId: TICKET_REOPEN_BUTTON_ID,
    };
}
