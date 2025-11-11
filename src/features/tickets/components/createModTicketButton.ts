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
import { CreateModTicketModalComponent } from './createModTicketModal';
import { InteractionHandlerResult } from '../../../features-system/commands/types';
import { ticketingRepo } from '../data/ticketingRepo';
import { isTicketingConfigConfigured } from '../data/ticketingSchema';

export const MOD_TICKET_BUTTON_ID = 'mod_ticket_create_button';

export function CreateModTicketButtonComponent(enabled: boolean = true) {
    function buildComponent() {
        const button = new ButtonBuilder()
            .setCustomId(MOD_TICKET_BUTTON_ID)
            .setLabel('Create Mod Ticket')
            .setStyle(ButtonStyle.Primary)
            .setDisabled(!enabled)
            .setEmoji('🎫');

        (button.data as Partial<APIButtonComponentWithCustomId>).custom_id;

        return button as ComponentBuilder<APIButtonComponentWithCustomId>;
    }

    async function handler(interaction: ButtonInteraction): Promise<InteractionHandlerResult> {
        // Check if user has the required role
        if (!interaction.guild || !interaction.member) {
            return { status: 'error', message: '❌ This command can only be used in a server.' };
        }

        // Check if ticketing system is configured
        try {
            const configEntity = await ticketingRepo.get(interaction.guild.id);
            if (!isTicketingConfigConfigured(configEntity)) {
                return {
                    status: 'error',
                    message:
                        '❌ The ticket system is not configured yet. Please ask an administrator to configure it first.',
                };
            }
            const ticketingConfig = configEntity.config;

            const member = interaction.member as GuildMember;
            const hasModRole =
                memberHasModeratorRole(member, ticketingConfig.moderationRoles) || memberHasModeratorPerms(member);

            if (!hasModRole) {
                return {
                    status: 'error',
                    message: `❌ You need moderation permissions or one of the configured moderation roles to create tickets.`,
                };
            }
        } catch (error) {
            console.error('Error checking ticket configuration:', error);
            return {
                status: 'error',
                message: '❌ Failed to check ticket system configuration. Please try again.',
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
