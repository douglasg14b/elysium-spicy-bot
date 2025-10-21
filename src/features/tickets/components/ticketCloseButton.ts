import {
    ActionRowBuilder,
    APIButtonComponentWithCustomId,
    ButtonBuilder,
    ButtonInteraction,
    ButtonStyle,
    ComponentBuilder,
    GuildMember,
    EmbedBuilder,
    ChannelType,
    PermissionsBitField,
} from 'discord.js';
import {
    memberHasModeratorPerms,
    memberHasModeratorRole,
    findTicketStateMessage,
    updateTicketState,
    closeTicketChannel,
    getClosedChannelName,
} from '../logic';
import { TICKET_BUTTON_CONFIGS } from '../logic/ticketButtonConfigs';
import { TICKETING_CONFIG } from '../ticketsConfig';
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
                )}** role or moderation permissions to close tickets.`,
            };
        }

        const channel = interaction.channel;
        if (!channel || !channel.isTextBased() || channel.isDMBased()) {
            return { status: 'error', message: '❌ This can only be used in a server text channel.' };
        }

        // Check if this is a text channel and get ticket state
        if (channel.type !== ChannelType.GuildText) {
            return { status: 'error', message: '❌ This command can only be used in text channels.' };
        }

        const stateInfo = await findTicketStateMessage(channel);
        if (!stateInfo) {
            return { status: 'error', message: '❌ This command can only be used in ticket channels.' };
        }

        if (stateInfo.state.status === 'closed') {
            return { status: 'error', message: '❌ This ticket is already closed.' };
        }

        try {
            const guild = interaction.guild;
            const newChannelName = getClosedChannelName(channel.name);

            console.log(`Closing ticket channel ${channel.id} (${channel.name})`);

            // Close the ticket using business logic
            await closeTicketChannel(channel, guild, newChannelName);

            // Update ticket state
            await updateTicketState(
                channel,
                {
                    status: 'closed',
                },
                guild
            );

            // Acknowledge the button interaction
            await interaction.deferUpdate();

            // Send public message to the channel
            await channel.send(`🔒 **Ticket Closed**\nThis ticket has been closed by ${member}.`);

            return { status: 'success' };
        } catch (error) {
            console.error('Error closing ticket:', error);
            return { status: 'error', message: '❌ Failed to close ticket. Please try again.' };
        }
    }

    return {
        handler,
        component: buildComponent,
        interactionId: TICKET_CLOSE_BUTTON_ID,
    };
}
