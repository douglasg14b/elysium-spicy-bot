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
} from 'discord.js';
import {
    memberHasModeratorPerms,
    memberHasModeratorRole,
    findTicketStateMessage,
    updateTicketState,
    reopenTicketChannel,
    getOriginalChannelName,
} from '../logic';
import { TICKETING_CONFIG } from '../ticketsConfig';
import { InteractionHandlerResult } from '../../../features-system/commands/types';

export const TICKET_REOPEN_BUTTON_ID = 'ticket_reopen_button';

export function TicketReopenButtonComponent() {
    function buildComponent(enabled: boolean) {
        const button = new ButtonBuilder()
            .setCustomId(TICKET_REOPEN_BUTTON_ID)
            .setLabel('Reopen')
            .setStyle(ButtonStyle.Success)
            .setEmoji('🔓')
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
                )}** role or moderation permissions to reopen tickets.`,
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

        if (stateInfo.state.status !== 'closed') {
            return { status: 'error', message: '❌ This ticket is not closed and cannot be reopened.' };
        }

        try {
            const guild = interaction.guild;
            const originalChannelName = getOriginalChannelName(channel.name);

            // Use the target user ID from the ticket state (more reliable than parsing name)
            const targetUserId = stateInfo.state.targetUserId;

            // Reopen the ticket using business logic
            await reopenTicketChannel(channel, guild, originalChannelName, targetUserId);

            // Update ticket state
            await updateTicketState(
                channel,
                {
                    status: 'active',
                    claimedByUserId: undefined, // Reset claimed status when reopening
                },
                guild
            );

            // Acknowledge the button interaction
            await interaction.deferUpdate();

            // Send public message to the channel
            await channel.send(`🔓 **Ticket Reopened**\nThis ticket has been reopened by ${member}.`);

            return { status: 'success' };
        } catch (error) {
            console.error('Error reopening ticket:', error);
            return { status: 'error', message: '❌ Failed to reopen ticket. Please try again.' };
        }
    }

    return {
        handler,
        component: buildComponent,
        interactionId: TICKET_REOPEN_BUTTON_ID,
    };
}
