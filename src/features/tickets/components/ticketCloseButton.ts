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
import { InteractionHandlerResult } from '../../../features-system/commands/types';
import { isTicketingConfigConfigured } from '../data/ticketingSchema';
import { ticketingRepo } from '../data/ticketingRepo';
import { roleIdsToNames, timeFnCall } from '../../../utils';

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

        const guild = interaction.guild;
        const configEntity = await timeFnCall(async () => await ticketingRepo.get(guild.id), 'ticketingRepo.get()');
        if (!isTicketingConfigConfigured(configEntity)) {
            return {
                status: 'error',
                message:
                    '❌ The ticket system is not configured yet. Please ask an administrator to configure it first.',
            };
        }
        const ticketsConfig = configEntity.config;

        const member = interaction.member as GuildMember;
        const hasModRole =
            memberHasModeratorRole(member, ticketsConfig.moderationRoles) || memberHasModeratorPerms(member);

        if (!hasModRole) {
            const roleNames = await timeFnCall(
                async () => await roleIdsToNames(guild, ticketsConfig.moderationRoles),
                'roleIdsToNames()'
            );

            return {
                status: 'error',
                message: `❌ You need the **${roleNames.join(', ')}** role or moderation permissions to close tickets.`,
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

        const stateInfo = await timeFnCall(
            async () => await findTicketStateMessage(channel),
            'findTicketStateMessage()'
        );
        if (!stateInfo) {
            return { status: 'error', message: '❌ This command can only be used in ticket channels.' };
        }

        if (stateInfo.state.status === 'closed') {
            return { status: 'error', message: '❌ This ticket is already closed.' };
        }

        try {
            // Acknowledge the button interaction
            await timeFnCall(async () => await interaction.deferUpdate(), 'interaction.deferUpdate()');

            const newChannelName = getClosedChannelName(channel.name);

            console.log(`Closing ticket channel ${channel.id} (${channel.name})`);

            // Close the ticket using business logic
            await timeFnCall(
                async () => await closeTicketChannel(channel, guild, newChannelName, ticketsConfig),
                'closeTicketChannel()'
            );

            // Update ticket state
            await timeFnCall(
                async () =>
                    await updateTicketState(
                        channel,
                        {
                            status: 'closed',
                        },
                        guild
                    ),
                'updateTicketState()'
            );

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
