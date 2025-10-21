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
import { memberHasModeratorPerms, memberHasModeratorRole, findTicketStateMessage, updateTicketState } from '../logic';
import { TICKET_BUTTON_CONFIGS } from '../logic/ticketButtonConfigs';
import { TICKETING_CONFIG } from '../ticketsConfig';
import { InteractionHandlerResult } from '../../../features-system/commands/types';

export const TICKET_CLAIM_BUTTON_ID = TICKET_BUTTON_CONFIGS.CLAIM.customId;

export function TicketClaimButtonComponent() {
    function buildComponent(enabled: boolean) {
        const button = new ButtonBuilder()
            .setCustomId(TICKET_BUTTON_CONFIGS.CLAIM.customId)
            .setLabel(TICKET_BUTTON_CONFIGS.CLAIM.label)
            .setStyle(TICKET_BUTTON_CONFIGS.CLAIM.style)
            .setEmoji(TICKET_BUTTON_CONFIGS.CLAIM.emoji)
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
                )}** role or moderation permissions to claim tickets.`,
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

        if (stateInfo.state.status !== 'active') {
            return { status: 'error', message: '❌ This ticket cannot be claimed in its current state.' };
        }

        try {
            // Update channel permissions to give the claimer manage permissions
            await channel.permissionOverwrites.edit(member.id, {
                ViewChannel: true,
                SendMessages: true,
                ReadMessageHistory: true,
                ManageMessages: true,
            });

            // Update ticket state
            await updateTicketState(
                channel,
                {
                    status: 'claimed',
                    claimedByUserId: member.id,
                },
                interaction.guild!
            );

            // Acknowledge the button interaction
            await interaction.deferUpdate();

            // Send public message to the channel
            await channel.send(`👋 **Ticket Claimed**\nThis ticket has been claimed by ${member}.`);

            return { status: 'success' };
        } catch (error) {
            console.error('Error claiming ticket:', error);
            return { status: 'error', message: '❌ Failed to claim ticket. Please try again.' };
        }
    }

    return {
        handler,
        component: buildComponent,
        interactionId: TICKET_CLAIM_BUTTON_ID,
    };
}
