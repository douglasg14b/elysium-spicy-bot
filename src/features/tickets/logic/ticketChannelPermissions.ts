import { Guild, TextChannel, PermissionsBitField, CategoryChannel, ChannelType } from 'discord.js';
import { ConfiguredTicketingConfig } from '../data/ticketingSchema';
import { timeFnCall } from '../../../utils';

export async function findOrCreateClosedTicketsCategory(
    guild: Guild,
    ticketingConfig: ConfiguredTicketingConfig
): Promise<CategoryChannel> {
    return findOrCreateModeratorCategory({
        guild,
        categoryName: ticketingConfig.closedTicketCategoryName,
        ticketingConfig,
    });
}

export async function findOrCreateActiveTicketsCategory(
    guild: Guild,
    ticketingConfig: ConfiguredTicketingConfig
): Promise<CategoryChannel> {
    return findOrCreateModeratorCategory({
        guild,
        categoryName: ticketingConfig.supportTicketCategoryName,
        ticketingConfig,
    });
}

interface FindOrCreateCategoryOptions {
    guild: Guild;
    categoryName: string;
    ticketingConfig: ConfiguredTicketingConfig;
}

async function findOrCreateModeratorCategory({ guild, categoryName, ticketingConfig }: FindOrCreateCategoryOptions) {
    let category = guild.channels.cache.find(
        (channel) => channel.type === ChannelType.GuildCategory && channel.name === categoryName
    ) as CategoryChannel;

    if (!category) {
        const me = guild.members.me!;
        const modRoles = guild.roles.cache.filter((role) => ticketingConfig.moderationRoles.includes(role.id));

        category = await guild.channels.create({
            name: categoryName,
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
export async function setupModeratorPermissions(channel: TextChannel, guild: Guild, roleIds: string[]): Promise<void> {
    const modRoles = guild.roles.cache.filter((role) => roleIds.includes(role.id));
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
export async function closeTicketChannel(
    channel: TextChannel,
    guild: Guild,
    newChannelName: string,
    ticketsConfig: ConfiguredTicketingConfig
): Promise<void> {
    // Find or create the closed tickets category
    const closedCategory = await findOrCreateClosedTicketsCategory(guild, ticketsConfig);

    // Remove view permissions for @everyone
    await channel.permissionOverwrites.edit(guild.roles.everyone.id, {
        ViewChannel: false,
    });

    // Ensure moderators can still access
    await setupModeratorPermissions(channel, guild, ticketsConfig.moderationRoles);

    // Update channel name and move to closed category
    await channel.setName(newChannelName);
    await channel.setParent(closedCategory);
}

interface ReopenTicketChannelParams {
    ticketsConfig: ConfiguredTicketingConfig;
    channel: TextChannel;
    guild: Guild;
    originalChannelName: string;
    targetUserId?: string;
}

/**
 * Reopens a ticket by restoring permissions, channel name, and moving back to active category
 */
export async function reopenTicketChannel({
    ticketsConfig,
    channel,
    guild,
    originalChannelName,
    targetUserId,
}: ReopenTicketChannelParams): Promise<void> {
    // Find or create the active tickets category
    const activeCategory = await timeFnCall(
        async () => await findOrCreateActiveTicketsCategory(guild, ticketsConfig),
        'findOrCreateActiveTicketsCategory()'
    );

    // Restore view permissions for @everyone (inherit from category)
    await timeFnCall(
        async () =>
            await channel.permissionOverwrites.edit(guild.roles.everyone.id, {
                ViewChannel: null,
                SendMessages: null,
            }),
        'channel.permissionOverwrites.edit(@everyone)'
    );

    // If we have the target user, restore their permissions
    if (targetUserId) {
        await timeFnCall(
            async () =>
                await channel.permissionOverwrites.edit(targetUserId, {
                    ViewChannel: true,
                    SendMessages: true,
                    ReadMessageHistory: true,
                }),
            'channel.permissionOverwrites.edit(targetUser)'
        );
    }

    // Ensure moderators can still manage
    await timeFnCall(
        async () => await setupModeratorPermissions(channel, guild, ticketsConfig.moderationRoles),
        'setupModeratorPermissions()'
    );

    // Update channel name and move back to active category
    await timeFnCall(async () => await channel.setName(originalChannelName), 'channel.setName()');
    await timeFnCall(async () => await channel.setParent(activeCategory), 'channel.setParent()');
}
