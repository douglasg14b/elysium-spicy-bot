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
import { InteractionHandlerResult } from '../../../features-system/commands/types';
import { ticketingRepo } from '../data/ticketingRepo';
import { isTicketingConfigConfigured } from '../data/ticketingSchema';
import { roleIdsToNames, timeFnCall } from '../../../utils';

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
                message: `❌ You need the **${roleNames.join(', ')}** role or moderation permissions to claim tickets.`,
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

        if (stateInfo.state.status === 'claimed') {
            // If claimed by current user, inform them
            if (stateInfo.state.claimedByUserId === member.id) {
                return { status: 'error', message: '❌ You have already claimed this ticket.' };
            }
        }

        if (stateInfo.state.status !== 'active') {
            return { status: 'error', message: '❌ This ticket cannot be claimed in its current state.' };
        }

        try {
            // Acknowledge the button interaction
            await timeFnCall(async () => await interaction.deferUpdate(), 'interaction.deferUpdate()');

            // Update channel permissions to give the claimer manage permissions
            await timeFnCall(
                async () =>
                    await channel.permissionOverwrites.edit(member.id, {
                        ViewChannel: true,
                        SendMessages: true,
                        ReadMessageHistory: true,
                        ManageMessages: true,
                    }),
                'channel.permissionOverwrites.edit()'
            );

            // Update ticket state
            await timeFnCall(
                async () =>
                    await updateTicketState(
                        channel,
                        {
                            status: 'claimed',
                            claimedByUserId: member.id,
                        },
                        interaction.guild!
                    ),
                'updateTicketState()'
            );

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
