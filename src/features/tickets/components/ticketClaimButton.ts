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
     * Gate, then orchestrate, then surface. The eligibility rules — already claimed,
     * claimed by you, not open — belong to `claimTicket`, and the commit-sync-render-
     * announce sequence belongs to `applyTicketTransition`, which the dashboard also
     * calls. What is left here is the Discord half of *this* surface: acknowledge the
     * press, and tell the member if the channel did not follow the record.
     *
     * `interaction.message` is passed because this handler already holds it — the
     * button is on it. Absent that, the orchestration resolves the message from
     * `stateMessageId`, which is the path a web caller takes.
     */
    async function handler(interaction: ButtonInteraction): Promise<InteractionHandlerResult> {
        const resolved = await resolveTicketAction(interaction, 'claim tickets');
        if (!resolved.ok) return replyTicketFailure(interaction, ticketErrorMessage(resolved.error));
        const { guild, member, config, ticket, definition } = resolved.value;

        await interaction.deferUpdate();

        // The claimer's names travel into the same guarded UPDATE as their id, so the
        // losing side of a race cannot stamp its name on the winner's claim. No fetch:
        // the acting member is already in hand.
        const result = await applyTicketTransition({
            guild,
            config,
            ticket,
            definition,
            transition: 'claim',
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
        interactionId: TICKET_CLAIM_BUTTON_ID,
    };
}
