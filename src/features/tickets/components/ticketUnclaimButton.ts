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
    findCategory,
    findOrCreateModeratorCategory,
} from '../logic';
import { TICKET_BUTTON_CONFIGS } from '../logic/ticketButtonConfigs';
import { InteractionHandlerResult } from '../../../features-system/commands/types';
import { ticketingRepo } from '../data/ticketingRepo';
import { isTicketingConfigConfigured } from '../data/ticketingSchema';
import { roleIdsToNames, timeFnCall } from '../../../utils';

export const TICKET_UNCLAIM_BUTTON_ID = TICKET_BUTTON_CONFIGS.UNCLAIM.customId;

export function TicketUnclaimButtonComponent() {
    function buildComponent(enabled: boolean) {
        const button = new ButtonBuilder()
            .setCustomId(TICKET_BUTTON_CONFIGS.UNCLAIM.customId)
            .setLabel(TICKET_BUTTON_CONFIGS.UNCLAIM.label)
            .setStyle(TICKET_BUTTON_CONFIGS.UNCLAIM.style)
            .setEmoji(TICKET_BUTTON_CONFIGS.UNCLAIM.emoji)
            .setDisabled(!enabled);

        return button as ComponentBuilder<APIButtonComponentWithCustomId>;
    }

    async function handler(interaction: ButtonInteraction): Promise<InteractionHandlerResult> {
        const startTime = performance.now();

        // Check if user has the required role
        if (!interaction.guild || !interaction.member) {
            return { status: 'error', message: '❌ This command can only be used in a server.' };
        }

        const guild = interaction.guild;
        const guildId = interaction.guild.id;

        const configEntity = await timeFnCall(async () => await ticketingRepo.get(guildId), 'ticketingRepo.get()');
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
                message: `❌ You need the **${roleNames.join(
                    ', '
                )}** role or moderation permissions to unclaim tickets.`,
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

        if (stateInfo.state.status !== 'claimed') {
            return { status: 'error', message: '❌ This ticket is not currently claimed.' };
        }

        // Check if the user is the one who claimed the ticket or has mod permissions
        const isTicketClaimer = stateInfo.state.claimedByUserId === member.id;
        if (!isTicketClaimer && !hasModRole) {
            return { status: 'error', message: '❌ You can only unclaim tickets you have claimed.' };
        }

        try {
            const supportTicketsCategoryResult = await findOrCreateModeratorCategory({
                guild,
                categoryName: ticketsConfig.supportTicketCategoryName,
                moderationRoleIds: ticketsConfig.moderationRoles,
            });
            if (!supportTicketsCategoryResult.ok) {
                return {
                    status: 'error',
                    message: '❌ Support tickets category not found. Please contact an administrator.',
                };
            }
            const supportTicketsCategory = supportTicketsCategoryResult.value;

            // Acknowledge the button interaction
            await timeFnCall(async () => await interaction.deferUpdate(), 'interaction.deferUpdate()');

            // Remove the claimer's manage permissions (keep basic permissions)
            if (stateInfo.state.claimedByUserId) {
                await timeFnCall(
                    async () =>
                        await channel.permissionOverwrites.edit(stateInfo.state.claimedByUserId!, {
                            ViewChannel: true,
                            SendMessages: true,
                            ReadMessageHistory: true,
                            ManageMessages: false, // Remove manage permissions
                        }),
                    'channel.permissionOverwrites.edit()'
                );
            }

            // Move ticket back to support tickets category
            await channel.setParent(supportTicketsCategory.id);

            // Update ticket state to active
            await timeFnCall(
                async () =>
                    await updateTicketState(
                        channel,
                        {
                            status: 'active',
                            claimedByUserId: undefined,
                        },
                        interaction.guild!
                    ),
                'updateTicketState()'
            );

            // Send public message to the channel
            await channel.send(
                `🔄 **Ticket Unclaimed**\nThis ticket has been unclaimed and moved back to active status.`
            );

            return { status: 'success' };
        } catch (error) {
            console.error('Error unclaiming ticket:', error);
            return { status: 'error', message: '❌ Failed to unclaim ticket. Please try again.' };
        }
    }

    return {
        handler,
        component: buildComponent,
        interactionId: TICKET_UNCLAIM_BUTTON_ID,
    };
}
