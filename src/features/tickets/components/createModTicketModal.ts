import {
    ActionRowBuilder,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    ModalSubmitInteraction,
    TextChannel,
    UserSelectMenuBuilder,
    LabelBuilder,
} from 'discord.js';
import { DISCORD_CLIENT } from '../../../discordClient';
import { InteractionHandlerResult } from '../../../features-system/commands/types';
import { createTicketChannel } from '../logic';
import { ticketingRepo } from '../data/ticketingRepo';
import { isTicketingConfigConfigured } from '../data/ticketingSchema';

const MOD_TICKET_MODAL_ID = 'mod_ticket_create_modal';

const USER_INPUT_ID = 'mod_ticket_user_input';
const TITLE_INPUT_ID = 'mod_ticket_title_input';
const REASON_INPUT_ID = 'mod_ticket_reason_input';

export function CreateModTicketModalComponent() {
    function buildComponent() {
        const userLabel = new LabelBuilder()
            .setLabel('User')
            .setUserSelectMenuComponent(
                new UserSelectMenuBuilder().setCustomId(USER_INPUT_ID).setMaxValues(1).setPlaceholder('Select a user')
            );

        const titleInput = new TextInputBuilder()
            .setCustomId(TITLE_INPUT_ID)
            .setLabel('Ticket Title')
            .setStyle(TextInputStyle.Short)
            .setPlaceholder('Brief description of the issue')
            .setRequired(true)
            .setMaxLength(100);

        const reasonInput = new TextInputBuilder()
            .setCustomId(REASON_INPUT_ID)
            .setLabel('Reason/Details (Optional)')
            .setStyle(TextInputStyle.Paragraph)
            .setPlaceholder('Additional context or details about this ticket')
            .setRequired(false)
            .setMaxLength(1000);

        const modal = new ModalBuilder()
            .setCustomId(MOD_TICKET_MODAL_ID)
            .setTitle('Create Mod Ticket')
            .addLabelComponents(userLabel)
            .addComponents(
                new ActionRowBuilder<TextInputBuilder>({ components: [titleInput] }),
                new ActionRowBuilder<TextInputBuilder>({ components: [reasonInput] })
            );

        return modal;
    }

    async function handler(interaction: ModalSubmitInteraction): Promise<InteractionHandlerResult> {
        const userInput = interaction.fields.getSelectedUsers(USER_INPUT_ID);
        const title = interaction.fields.getTextInputValue(TITLE_INPUT_ID);
        const reason = interaction.fields.getTextInputValue(REASON_INPUT_ID) || 'No additional details provided';
        const userId = userInput?.first()?.id;

        if (!userId) {
            return { status: 'error', message: '❌ You must select a user for the ticket.' };
        }

        if (!interaction.guild) {
            return { status: 'error', message: '❌ This command can only be used in a server.' };
        }

        // Try to get the user
        let targetUser;
        try {
            targetUser = await DISCORD_CLIENT.users.fetch(userId);
        } catch (error) {
            return {
                status: 'error',
                message: '❌ Could not find a user with that ID. Please check the user ID and try again.',
            };
        }

        const configEntity = await ticketingRepo.get(interaction.guild.id);
        if (!isTicketingConfigConfigured(configEntity)) {
            return {
                status: 'error',
                message:
                    '❌ The ticket system is not configured yet. Please ask an administrator to configure it first.',
            };
        }
        const ticketsConfig = configEntity.config;
        configEntity.ticketNumberInc += 1;
        const nextTicketNumber = configEntity.ticketNumberInc;

        try {
            // Create the ticket channel
            const ticketChannelResult = await createTicketChannel({
                interaction,
                ticketingConfig: ticketsConfig,
                targetUser,
                title,
                reason,
                nextTicketNumber,
            });
            if (!ticketChannelResult.ok) {
                return { status: 'error', message: `❌ Failed to create ticket: ${ticketChannelResult.error}` };
            }
            const ticketChannel = ticketChannelResult.value;

            await interaction.reply({
                content: `✅ Ticket created successfully! ${ticketChannel}`,
                ephemeral: true,
            });

            // Ensure we persist the ticket# change
            await ticketingRepo.update({
                ...configEntity,
                config: JSON.stringify(configEntity.config),
            });

            return { status: 'success' };
        } catch (error) {
            console.error('Error creating ticket:', error);
            return {
                status: 'error',
                message: '❌ Failed to create ticket. Please try again or contact an administrator.',
            };
        }
    }

    return {
        handler,
        component: buildComponent(),
        interactionId: MOD_TICKET_MODAL_ID,
    };
}
