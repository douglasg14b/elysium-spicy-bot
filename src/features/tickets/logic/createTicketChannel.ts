import {
    CategoryChannel,
    ChannelType,
    EmbedBuilder,
    ModalSubmitInteraction,
    PermissionsBitField,
    TextChannel,
    User,
} from 'discord.js';
import { buildTicketChannelName } from './buildTicketChannelName';
import { findOrCreateActiveTicketsCategory } from './ticketChannelPermissions';
import { TicketState, createTicketEmbed, createTicketActionButtons } from './ticketState';
import { ConfiguredTicketingConfig } from '../data/ticketingSchema';

interface CreateTicketChannelParams {
    interaction: ModalSubmitInteraction;
    ticketingConfig: ConfiguredTicketingConfig;
    targetUser: User;
    title: string;
    reason: string;
    nextTicketNumber: number;
}

/**
 * Creates the actual ticket channel with proper permissions
 */
export async function createTicketChannel({
    interaction,
    ticketingConfig,
    targetUser,
    title,
    reason,
    nextTicketNumber: nextTicketId,
}: CreateTicketChannelParams): Promise<TextChannel> {
    const guild = interaction.guild!;
    const creator = interaction.user;
    const me = guild.members.me!;
    const modRoles = guild.roles.cache.filter((role) => ticketingConfig.moderationRoles.includes(role.id));

    // Find or create the active tickets category
    const category = await findOrCreateActiveTicketsCategory(guild, ticketingConfig);

    const canManageInParent = category.permissionsFor(me)?.has(PermissionsBitField.Flags.ManageChannels);
    const canSeeParent = category.permissionsFor(me)?.has(PermissionsBitField.Flags.ViewChannel);
    if (!canManageInParent) {
        throw new Error('Bot lacks ManageChannels in the chosen category');
    }

    if (!canSeeParent) {
        throw new Error('Bot lacks ViewChannel in the chosen category');
    }

    const channelName = buildTicketChannelName({
        ticketId: nextTicketId,
        targetUserName: targetUser.username,
        creatorUserName: creator.username,
    });

    // Create the ticket channel
    const ticketChannel = await guild.channels.create({
        name: channelName,
        type: ChannelType.GuildText,
        parent: category,
        permissionOverwrites: [
            {
                id: guild.roles.everyone.id,
                deny: [PermissionsBitField.Flags.ViewChannel],
            },
            {
                id: targetUser.id,
                allow: [
                    PermissionsBitField.Flags.ViewChannel,
                    PermissionsBitField.Flags.SendMessages,
                    PermissionsBitField.Flags.ReadMessageHistory,
                ],
            },
            {
                id: creator.id,
                allow: [
                    PermissionsBitField.Flags.ViewChannel,
                    PermissionsBitField.Flags.SendMessages,
                    PermissionsBitField.Flags.ReadMessageHistory,
                    PermissionsBitField.Flags.ManageMessages,
                ],
            },
            {
                id: me.id,
                allow: [
                    PermissionsBitField.Flags.ViewChannel,
                    PermissionsBitField.Flags.SendMessages,
                    PermissionsBitField.Flags.ReadMessageHistory,
                    PermissionsBitField.Flags.ManageMessages,
                ],
            },
        ],
    });

    // Add mod role permissions if it exists
    if (modRoles.size > 0) {
        for (const [modRoleName] of modRoles) {
            await ticketChannel.permissionOverwrites.create(modRoleName, {
                ViewChannel: true,
                SendMessages: true,
                ReadMessageHistory: true,
                ManageMessages: true,
            });
        }
    }

    // Send initial message in the ticket with state management
    // Auto-claim tickets when created by a mod for a specific user
    const ticketState: TicketState = {
        ticketId: `${nextTicketId}`,
        targetUserId: targetUser.id,
        creatorUserId: creator.id,
        title: title,
        reason: reason,
        status: 'claimed', // Auto-claim when mod creates ticket for user
        claimedByUserId: creator.id, // Creator automatically claims the ticket
        createdAt: new Date(),
        updatedAt: new Date(),
    };

    const ticketEmbed = createTicketEmbed(ticketState, targetUser, creator, creator);
    const actionButtons = createTicketActionButtons(ticketState);

    const initialMessage = await ticketChannel.send({
        content: `${targetUser} - A moderation ticket has been created for you.`,
        embeds: [ticketEmbed],
        components: actionButtons,
    });

    // Pin the initial message for easy reference
    try {
        await initialMessage.pin();
    } catch (error) {
        console.warn('Failed to pin ticket message (missing permissions?):', error);
        // Continue without pinning - not critical for functionality
    }

    return ticketChannel;
}
