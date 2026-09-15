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
import { ticketingRepo } from '../data/ticketingRepo';
import { isTicketingConfigConfigured } from '../data/ticketingSchema';
import { attachTicketChannel, openTicket } from '../ticketService';
import { createTicketChannelForTicket } from '../logic/ticketChannelOps';
import { buildTicketButtons, buildTicketEmbed } from '../logic/ticketPresentation';
import { ticketErrorMessage } from '../logic/ticketErrorMessage';

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

        try {
            // The same path a flow takes, differing only in having a human
            // opener. Previously this handler had its own creation path: it
            // incremented the counter in memory, created the channel, and then
            // wrote the counter back *absolutely* — so it not only raced itself
            // across a Discord round trip, it would overwrite an atomic
            // increment made by any other opener in the meantime.
            const ticketResult = await openTicket({
                guildId: interaction.guild.id,
                type: 'support',
                subjectId: targetUser.id,
                openerId: interaction.user.id,
                title,
                reason,
            });
            if (!ticketResult.ok) {
                return {
                    status: 'error',
                    message: `❌ Failed to create ticket: ${ticketErrorMessage(ticketResult.error)}`,
                };
            }
            const ticket = ticketResult.value;

            const ticketChannelResult = await createTicketChannelForTicket({
                guild: interaction.guild,
                ticket,
                config: ticketsConfig,
                subjectName: targetUser.username,
                openerName: interaction.user.username,
            });
            if (!ticketChannelResult.ok) {
                return {
                    status: 'error',
                    message: `❌ Failed to create ticket: ${ticketErrorMessage(ticketChannelResult.error)}`,
                };
            }
            const ticketChannel = ticketChannelResult.value;

            const attached = await attachTicketChannel(ticket.id, ticketChannel.id);
            if (!attached.ok) {
                return {
                    status: 'error',
                    message: `❌ Failed to create ticket: ${ticketErrorMessage(attached.error)}`,
                };
            }

            const initialMessage = await ticketChannel.send({
                content: `${targetUser} - A moderation ticket has been created for you.`,
                embeds: [buildTicketEmbed(attached.value)],
                components: buildTicketButtons(attached.value),
                allowedMentions: { parse: ['users'] },
            });

            // Pinning is a convenience now rather than load-bearing: the row is
            // the ticket, so an unpinned message costs nothing but scrollback.
            await initialMessage.pin().catch(() => undefined);

            await interaction.reply({
                content: `✅ Ticket created successfully! ${ticketChannel}`,
                ephemeral: true,
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
