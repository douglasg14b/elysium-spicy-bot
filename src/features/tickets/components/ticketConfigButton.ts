import {
    ButtonBuilder,
    ButtonStyle,
    ButtonInteraction,
    APIButtonComponentWithCustomId,
    ComponentBuilder,
} from 'discord.js';
import { InteractionHandlerResult } from '../../../features-system/commands/types';
import { TicketConfigModalComponent } from './ticketConfigModal';
import { ticketingRepo } from '../data/ticketingRepo';

const TICKET_CONFIG_BUTTON_ID = 'ticket_config_button';

export function TicketConfigButtonComponent() {
    function buildComponent() {
        const button = new ButtonBuilder()
            .setCustomId(TICKET_CONFIG_BUTTON_ID)
            .setLabel('⚙️ Configure')
            .setStyle(ButtonStyle.Secondary);

        (button.data as Partial<APIButtonComponentWithCustomId>).custom_id;

        return button as ComponentBuilder<APIButtonComponentWithCustomId>;
    }

    async function handler(interaction: ButtonInteraction): Promise<InteractionHandlerResult> {
        if (!interaction.guild) {
            return { status: 'error', message: '❌ This command can only be used in a server.' };
        }

        // Check if user has administrator permissions
        if (!interaction.memberPermissions?.has('Administrator')) {
            return {
                status: 'error',
                message: '❌ You need Administrator permissions to configure the ticket system.',
            };
        }

        try {
            // Get existing configuration if any
            const existingConfig = await ticketingRepo.get(interaction.guild.id);
            const currentConfig = existingConfig?.config;

            // Create and show the modal
            const modalComponent = TicketConfigModalComponent();
            const modal = modalComponent.component(currentConfig);

            await interaction.showModal(modal);
            return { status: 'success' };
        } catch (error) {
            console.error('Error showing ticket config modal:', error);
            return {
                status: 'error',
                message: '❌ Failed to open configuration modal. Please try again or contact an administrator.',
            };
        }
    }

    return {
        component: buildComponent(),
        handler,
        interactionId: TICKET_CONFIG_BUTTON_ID,
    };
}
