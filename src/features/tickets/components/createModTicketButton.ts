import {
    ActionRowBuilder,
    APIButtonComponentWithCustomId,
    ButtonBuilder,
    ButtonInteraction,
    ButtonStyle,
    ComponentBuilder,
    GuildMember,
} from 'discord.js';
import { memberHasModeratorPerms, memberHasModeratorRole } from '../logic';
import { TICKETING_CONFIG } from '../ticketsConfig';
import { CreateModTicketModalComponent } from './createModTicketModal';
import { InteractionHandlerResult } from '../../../features-system/commands/types';

export const MOD_TICKET_BUTTON_ID = 'mod_ticket_create_button';

export function CreateModTicketButtonComponent() {
    function buildComponent() {
        const button = new ButtonBuilder()
            .setCustomId(MOD_TICKET_BUTTON_ID)
            .setLabel('Create Mod Ticket')
            .setStyle(ButtonStyle.Primary)
            .setEmoji('🎫');

        (button.data as Partial<APIButtonComponentWithCustomId>).custom_id;

        return button as ComponentBuilder<APIButtonComponentWithCustomId>;
    }

    async function handler(interaction: ButtonInteraction): Promise<InteractionHandlerResult> {
        // Check if user has the required role
        if (!interaction.guild || !interaction.member) {
            return { status: 'error', message: '❌ This command can only be used in a server.' };
        }

        const member = interaction.member as GuildMember;
        const hasModRole = memberHasModeratorRole(member) || memberHasModeratorPerms(member);

        if (!hasModRole) {
            return {
                status: 'error',
                message: `❌ You need the **${TICKETING_CONFIG.moderationRoles.join(
                    ', '
                )}** role or moderation permissions to create tickets.`,
            };
        }

        // Show the modal
        const modal = CreateModTicketModalComponent().component;
        await interaction.showModal(modal);

        return { status: 'success' };
    }

    return {
        handler,
        component: buildComponent(),
        interactionId: MOD_TICKET_BUTTON_ID,
    };
}
