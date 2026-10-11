import {
    ActionRowBuilder,
    APIButtonComponentWithCustomId,
    ButtonBuilder,
    ButtonInteraction,
    ButtonStyle,
    ComponentBuilder,
    DiscordAPIError,
    GuildMember,
} from 'discord.js';
import { inspect } from 'node:util';
import { listTicketTypes, memberHasModeratorPerms, memberHasModeratorRole } from '../logic';
import { CreateModTicketModalComponent } from './createModTicketModal';
import { InteractionHandlerResult } from '../../../features-system/commands/types';
import { ticketingRepo } from '../data/ticketingRepo';
import { isTicketingConfigConfigured, type TicketTypeDefinition } from '../data/ticketingSchema';
import { TICKETING_NOT_CONFIGURED_MESSAGE } from '../logic/ticketErrorMessage';

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
        let ticketTypes: TicketTypeDefinition[];
        try {
            const configEntity = await ticketingRepo.get(interaction.guild.id);
            if (!isTicketingConfigConfigured(configEntity)) {
                return {
                    status: 'error',
                    message: TICKETING_NOT_CONFIGURED_MESSAGE,
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

            ticketTypes = listTicketTypes(ticketingConfig);
            if (ticketTypes.length === 0) {
                return {
                    status: 'error',
                    message:
                        "❌ This server hasn't declared a single ticket type, so there's nothing to open. " +
                        'Go add one on the dashboard first.',
                };
            }
        } catch (error) {
            console.error('Error checking ticket configuration:', error);
            return {
                status: 'error',
                message: '❌ Failed to check ticket system configuration. Please try again.',
            };
        }

        // The options are operator data, and the builders validate them (on build, and again
        // when `showModal` serializes), so a bad stored type throws here rather than in code.
        try {
            const modal = CreateModTicketModalComponent().component(ticketTypes);
            await interaction.showModal(modal);
        } catch (error) {
            // Discord refusing the call (an expired interaction, say) is not a type problem;
            // the registry's own handling is the honest answer to that.
            if (error instanceof DiscordAPIError) {
                throw error;
            }
            // Inspected in full, because a builder failure is a validation error whose
            // useful part is nested several levels down.
            console.error(
                `Mod ticket modal failed to build for guild ${interaction.guild.id}; offered types: ` +
                    `${ticketTypes.map((definition) => definition.type).join(', ')}\n` +
                    inspect(error, { depth: null })
            );
            return {
                status: 'error',
                message:
                    "❌ Couldn't open the ticket form — one of this server's ticket types is misconfigured. " +
                    'An admin needs to fix it on the dashboard.',
            };
        }

        return { status: 'success' };
    }

    return {
        handler,
        component: buildComponent(),
        interactionId: MOD_TICKET_BUTTON_ID,
    };
}
