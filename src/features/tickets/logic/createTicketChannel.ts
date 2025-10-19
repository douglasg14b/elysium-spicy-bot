import {
    CategoryChannel,
    ChannelType,
    EmbedBuilder,
    ModalSubmitInteraction,
    PermissionsBitField,
    TextChannel,
    User,
} from 'discord.js';
import { TICKETING_CONFIG } from '../ticketsConfig';
import { buildTicketChannelName } from './buildTicketChannelName';

/**
 * Creates the actual ticket channel with proper permissions
 */
export async function createTicketChannel(
    interaction: ModalSubmitInteraction,
    targetUser: User,
    title: string,
    reason: string
): Promise<TextChannel> {
    const guild = interaction.guild!;
    const creator = interaction.user;

    const me = guild.members.me!;

    const modRoles = guild.roles.cache.filter((role) => TICKETING_CONFIG.moderationRoles.includes(role.name));

    // Find or create the ticket category
    let category = guild.channels.cache.find(
        (channel) =>
            channel.type === ChannelType.GuildCategory && channel.name === TICKETING_CONFIG.supportTicketCategoryName
    ) as CategoryChannel;

    if (!category) {
        category = await guild.channels.create({
            name: TICKETING_CONFIG.supportTicketCategoryName,
            type: ChannelType.GuildCategory,
            permissionOverwrites: [
                {
                    id: guild.roles.everyone.id,
                    deny: [PermissionsBitField.Flags.ViewChannel],
                },
                {
                    id: me.id,
                    allow: [
                        PermissionsBitField.Flags.ViewChannel,
                        PermissionsBitField.Flags.ManageChannels,
                        PermissionsBitField.Flags.ReadMessageHistory,
                        PermissionsBitField.Flags.SendMessages, // not strictly needed on category, but harmless
                    ],
                },
                //TODO: Allow moderators
            ],
        });
    }

    if (modRoles.size > 0) {
        for (const [modRoleName] of modRoles) {
            await category.permissionOverwrites.create(modRoleName, {
                ViewChannel: true,
                SendMessages: true,
                ReadMessageHistory: true,
                ManageMessages: true,
            });
        }
    }

    const canManageInParent = category.permissionsFor(me)?.has(PermissionsBitField.Flags.ManageChannels);
    const canSeeParent = category.permissionsFor(me)?.has(PermissionsBitField.Flags.ViewChannel);
    if (!canManageInParent) {
        throw new Error('Bot lacks ManageChannels in the chosen category');
    }

    if (!canSeeParent) {
        throw new Error('Bot lacks ViewChannel in the chosen category');
    }

    //TODO: Track an incrementing number for ticket IDs
    // Generate channel name
    const ticketNumber = Math.floor(Math.random() * 9999)
        .toString()
        .padStart(4, '0');

    const channelName = buildTicketChannelName({
        ticketId: parseInt(ticketNumber),
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

    // Send initial message in the ticket
    const ticketEmbed = new EmbedBuilder()
        .setTitle(`🎫 Ticket #${ticketNumber}`)
        .setDescription(`**Title:** ${title}`)
        .addFields(
            { name: '👤 Target User', value: `${targetUser} (${targetUser.tag})`, inline: true },
            { name: '👮 Created By', value: `${creator} (${creator.tag})`, inline: true },
            { name: '📝 Reason', value: reason, inline: false }
        )
        .setColor(0xff9900)
        .setTimestamp();

    await ticketChannel.send({
        content: `${targetUser} - A moderation ticket has been created for you.`,
        embeds: [ticketEmbed],
    });

    return ticketChannel;
}
