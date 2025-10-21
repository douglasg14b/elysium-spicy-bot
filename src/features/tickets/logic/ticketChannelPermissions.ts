import { Guild, TextChannel, PermissionsBitField, CategoryChannel, ChannelType } from 'discord.js';
import { TICKETING_CONFIG } from '../ticketsConfig';

/**
 * Finds or creates the closed tickets category
 */
export async function findOrCreateClosedTicketsCategory(guild: Guild): Promise<CategoryChannel> {
    let category = guild.channels.cache.find(
        (channel) =>
            channel.type === ChannelType.GuildCategory && channel.name === TICKETING_CONFIG.closedTicketCategoryName
    ) as CategoryChannel;

    if (!category) {
        const me = guild.members.me!;
        const modRoles = guild.roles.cache.filter((role) => TICKETING_CONFIG.moderationRoles.includes(role.name));

        category = await guild.channels.create({
            name: TICKETING_CONFIG.closedTicketCategoryName,
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
                        PermissionsBitField.Flags.SendMessages,
                    ],
                },
            ],
        });

        // Add mod role permissions
        if (modRoles.size > 0) {
            for (const [, modRole] of modRoles) {
                await category.permissionOverwrites.create(modRole.id, {
                    ViewChannel: true,
                    SendMessages: true,
                    ReadMessageHistory: true,
                    ManageMessages: true,
                });
            }
        }
    }

    return category;
}

/**
 * Finds or creates the active tickets category
 */
export async function findOrCreateActiveTicketsCategory(guild: Guild): Promise<CategoryChannel> {
    let category = guild.channels.cache.find(
        (channel) =>
            channel.type === ChannelType.GuildCategory && channel.name === TICKETING_CONFIG.supportTicketCategoryName
    ) as CategoryChannel;

    if (!category) {
        const me = guild.members.me!;
        const modRoles = guild.roles.cache.filter((role) => TICKETING_CONFIG.moderationRoles.includes(role.name));

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
                        PermissionsBitField.Flags.SendMessages,
                    ],
                },
            ],
        });

        // Add mod role permissions
        if (modRoles.size > 0) {
            for (const [, modRole] of modRoles) {
                await category.permissionOverwrites.create(modRole.id, {
                    ViewChannel: true,
                    SendMessages: true,
                    ReadMessageHistory: true,
                    ManageMessages: true,
                });
            }
        }
    }

    return category;
}
/**
 * Sets up standard permissions for moderators on a ticket channel
 */
export async function setupModeratorPermissions(channel: TextChannel, guild: Guild): Promise<void> {
    const modRoles = guild.roles.cache.filter((role) => TICKETING_CONFIG.moderationRoles.includes(role.name));
    const me = guild.members.me!;

    // Set permissions for each moderator role
    for (const [, modRole] of modRoles) {
        await channel.permissionOverwrites.edit(modRole.id, {
            ViewChannel: true,
            SendMessages: true,
            ReadMessageHistory: true,
            ManageMessages: true,
        });
    }

    // Ensure bot can manage the channel
    await channel.permissionOverwrites.edit(me.id, {
        ViewChannel: true,
        SendMessages: true,
        ReadMessageHistory: true,
        ManageMessages: true,
    });
}

/**
 * Closes a ticket by updating permissions, channel name, and moving to closed category
 */
export async function closeTicketChannel(channel: TextChannel, guild: Guild, newChannelName: string): Promise<void> {
    // Find or create the closed tickets category
    const closedCategory = await findOrCreateClosedTicketsCategory(guild);

    // Remove view permissions for @everyone
    await channel.permissionOverwrites.edit(guild.roles.everyone.id, {
        ViewChannel: false,
    });

    // Ensure moderators can still access
    await setupModeratorPermissions(channel, guild);

    // Update channel name and move to closed category
    await channel.setName(newChannelName);
    await channel.setParent(closedCategory);
}

/**
 * Reopens a ticket by restoring permissions, channel name, and moving back to active category
 */
export async function reopenTicketChannel(
    channel: TextChannel,
    guild: Guild,
    originalChannelName: string,
    targetUserId?: string
): Promise<void> {
    // Find or create the active tickets category
    const activeCategory = await findOrCreateActiveTicketsCategory(guild);

    // Restore view permissions for @everyone (inherit from category)
    await channel.permissionOverwrites.edit(guild.roles.everyone.id, {
        ViewChannel: null,
        SendMessages: null,
    });

    // If we have the target user, restore their permissions
    if (targetUserId) {
        await channel.permissionOverwrites.edit(targetUserId, {
            ViewChannel: true,
            SendMessages: true,
            ReadMessageHistory: true,
        });
    }

    // Ensure moderators can still manage
    await setupModeratorPermissions(channel, guild);

    // Update channel name and move back to active category
    await channel.setName(originalChannelName);
    await channel.setParent(activeCategory);
}
