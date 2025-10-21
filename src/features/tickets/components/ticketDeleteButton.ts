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
import { memberHasModeratorPerms, memberHasModeratorRole, findTicketStateMessage } from '../logic';
import { TICKET_BUTTON_CONFIGS } from '../logic/ticketButtonConfigs';
import { TICKETING_CONFIG } from '../ticketsConfig';
import { InteractionHandlerResult } from '../../../features-system/commands/types';

export const TICKET_DELETE_BUTTON_ID = TICKET_BUTTON_CONFIGS.DELETE.customId;

export function TicketDeleteButtonComponent() {
    function buildComponent(enabled: boolean) {
        const button = new ButtonBuilder()
            .setCustomId(TICKET_DELETE_BUTTON_ID)
            .setLabel('Delete')
            .setStyle(ButtonStyle.Danger)
            .setEmoji('🗑️')
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
                )}** role or moderation permissions to delete tickets.`,
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

        try {
            // Acknowledge the button interaction
            await interaction.deferUpdate();

            // Send deletion warning to the channel
            const deleteEmbed = new EmbedBuilder()
                .setTitle('🗑️ Ticket Deletion')
                .setDescription(
                    `**WARNING:** This ticket will be permanently deleted by ${member} in 10 seconds.\n\n⚠️ **This action cannot be undone!**`
                )
                .setColor(0xff0000)
                .setTimestamp();

            await channel.send({
                embeds: [deleteEmbed],
            });

            // Wait 10 seconds before deletion
            setTimeout(async () => {
                try {
                    await channel.delete('Ticket deleted by moderator');
                } catch (error) {
                    console.error('Error deleting ticket channel:', error);
                    // If we can still send messages, notify about the error
                    try {
                        const errorEmbed = new EmbedBuilder()
                            .setTitle('❌ Deletion Failed')
                            .setDescription('Failed to delete the ticket channel. Please try again or delete manually.')
                            .setColor(0xff0000)
                            .setTimestamp();

                        await channel.send({ embeds: [errorEmbed] });
                    } catch (sendError) {
                        // Channel might be deleted or bot lost permissions
                        console.error('Could not send error message:', sendError);
                    }
                }
            }, 10000);

            return { status: 'success' };
        } catch (error) {
            console.error('Error initiating ticket deletion:', error);
            return { status: 'error', message: '❌ Failed to initiate ticket deletion. Please try again.' };
        }
    }

    return {
        handler,
        component: buildComponent,
        interactionId: TICKET_DELETE_BUTTON_ID,
    };
}
