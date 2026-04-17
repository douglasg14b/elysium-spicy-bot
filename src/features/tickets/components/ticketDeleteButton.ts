import {
    ActionRowBuilder,
    APIButtonComponentWithCustomId,
    ButtonBuilder,
    ButtonInteraction,
    ComponentBuilder,
    GuildMember,
    EmbedBuilder,
    ChannelType,
} from 'discord.js';
import { memberHasModeratorPerms, memberHasModeratorRole, findTicketStateMessage } from '../logic';
import { TICKET_BUTTON_CONFIGS } from '../logic/ticketButtonConfigs';
import { InteractionHandlerResult } from '../../../features-system/commands/types';
import { ticketingRepo } from '../data/ticketingRepo';
import { isTicketingConfigConfigured } from '../data/ticketingSchema';
import { roleIdsToNames } from '../../../utils';

export const TICKET_DELETE_BUTTON_ID = TICKET_BUTTON_CONFIGS.DELETE.customId;
export const TICKET_CONFIRM_DELETE_BUTTON_ID = TICKET_BUTTON_CONFIGS.CONFIRM_DELETE.customId;

type DeleteValidationResult = { ok: true } | ({ ok: false } & InteractionHandlerResult);

async function validateDeleteRequest(interaction: ButtonInteraction): Promise<DeleteValidationResult> {
    if (!interaction.guild || !interaction.member) {
        return { ok: false, status: 'error', message: '❌ This command can only be used in a server.' };
    }

    const configEntity = await ticketingRepo.get(interaction.guild.id);
    if (!isTicketingConfigConfigured(configEntity)) {
        return {
            ok: false,
            status: 'error',
            message: '❌ The ticket system is not configured yet. Please ask an administrator to configure it first.',
        };
    }

    const ticketsConfig = configEntity.config;
    const member = interaction.member as GuildMember;
    const hasModRole =
        memberHasModeratorRole(member, ticketsConfig.moderationRoles) || memberHasModeratorPerms(member);

    if (!hasModRole) {
        const roleNames = await roleIdsToNames(interaction.guild, ticketsConfig.moderationRoles);
        return {
            ok: false,
            status: 'error',
            message: `❌ You need the **${roleNames.join(', ')}** role or moderation permissions to delete tickets.`,
        };
    }

    const channel = interaction.channel;
    if (!channel || !channel.isTextBased() || channel.isDMBased()) {
        return { ok: false, status: 'error', message: '❌ This can only be used in a server text channel.' };
    }

    if (channel.type !== ChannelType.GuildText) {
        return { ok: false, status: 'error', message: '❌ This command can only be used in text channels.' };
    }

    const stateInfo = await findTicketStateMessage(channel);
    if (!stateInfo) {
        return { ok: false, status: 'error', message: '❌ This command can only be used in ticket channels.' };
    }

    return { ok: true };
}

export function TicketDeleteButtonComponent() {
    function buildComponent(enabled: boolean) {
        const button = new ButtonBuilder()
            .setCustomId(TICKET_DELETE_BUTTON_ID)
            .setLabel(TICKET_BUTTON_CONFIGS.DELETE.label)
            .setStyle(TICKET_BUTTON_CONFIGS.DELETE.style)
            .setEmoji(TICKET_BUTTON_CONFIGS.DELETE.emoji)
            .setDisabled(!enabled);

        return button as ComponentBuilder<APIButtonComponentWithCustomId>;
    }

    async function handler(interaction: ButtonInteraction): Promise<InteractionHandlerResult> {
        const validationResult = await validateDeleteRequest(interaction);
        if (!validationResult.ok) {
            return validationResult;
        }

        try {
            const confirmDeleteButton = new ButtonBuilder()
                .setCustomId(TICKET_CONFIRM_DELETE_BUTTON_ID)
                .setLabel(TICKET_BUTTON_CONFIGS.CONFIRM_DELETE.label)
                .setStyle(TICKET_BUTTON_CONFIGS.CONFIRM_DELETE.style)
                .setEmoji(TICKET_BUTTON_CONFIGS.CONFIRM_DELETE.emoji);
            const components = [new ActionRowBuilder<ButtonBuilder>().addComponents(confirmDeleteButton)];

            const confirmationEmbed = new EmbedBuilder()
                .setTitle('⚠️ Confirm Ticket Deletion')
                .setDescription(
                    `You are about to permanently delete this ticket.\n\nClick **${TICKET_BUTTON_CONFIGS.CONFIRM_DELETE.label}** to continue.`
                )
                .setColor(0xff0000)
                .setTimestamp();

            await interaction.reply({
                embeds: [confirmationEmbed],
                components,
                ephemeral: true,
            });

            return { status: 'success' };
        } catch (error) {
            console.error('Error showing ticket deletion confirmation:', error);
            return { status: 'error', message: '❌ Failed to show deletion confirmation. Please try again.' };
        }
    }

    return {
        handler,
        component: buildComponent,
        interactionId: TICKET_DELETE_BUTTON_ID,
    };
}

export function TicketConfirmDeleteButtonComponent() {
    function buildComponent(enabled: boolean) {
        const button = new ButtonBuilder()
            .setCustomId(TICKET_CONFIRM_DELETE_BUTTON_ID)
            .setLabel(TICKET_BUTTON_CONFIGS.CONFIRM_DELETE.label)
            .setStyle(TICKET_BUTTON_CONFIGS.CONFIRM_DELETE.style)
            .setEmoji(TICKET_BUTTON_CONFIGS.CONFIRM_DELETE.emoji)
            .setDisabled(!enabled);

        return button as ComponentBuilder<APIButtonComponentWithCustomId>;
    }

    async function handler(interaction: ButtonInteraction): Promise<InteractionHandlerResult> {
        const validationResult = await validateDeleteRequest(interaction);
        if (!validationResult.ok) {
            return validationResult;
        }

        const channel = interaction.channel;
        if (!channel || channel.type !== ChannelType.GuildText) {
            return { status: 'error', message: '❌ This command can only be used in text channels.' };
        }

        const deleteFailureMessage = '❌ Failed to delete the ticket channel. Please try again or delete manually.';
        try {
            await interaction.update({
                content: '🗑️ Deleting ticket...',
                embeds: [],
                components: [],
            });
        } catch (error) {
            console.error('Error acknowledging delete confirmation interaction:', error);
            return { status: 'error', message: deleteFailureMessage };
        }

        try {
            await channel.delete(`Ticket deleted by ${interaction.user.tag}`);
            return { status: 'success' };
        } catch (error) {
            console.error('Error deleting ticket channel after confirmation:', error);
            if (interaction.deferred || interaction.replied) {
                try {
                    await interaction.followUp({
                        content: deleteFailureMessage,
                        ephemeral: true,
                    });
                } catch (followUpError) {
                    console.error('Error sending delete failure follow-up:', followUpError);
                }
            }

            return { status: 'error', message: deleteFailureMessage };
        }
    }

    return {
        handler,
        component: buildComponent,
        interactionId: TICKET_CONFIRM_DELETE_BUTTON_ID,
    };
}
