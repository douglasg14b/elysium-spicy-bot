import { Guild, TextChannel, PermissionsBitField, CategoryChannel, ChannelType, GuildMember } from 'discord.js';
import { ConfiguredTicketingConfig } from '../data/ticketingSchema';
import { timeFnCall } from '../../../utils';
import { fail, ok, Result } from '../../../shared';
import { findTicketStateMessage, TicketState } from './ticketState';

interface FindOrCreateCategoryOptions {
    guild: Guild;
    categoryName: string;
    moderationRoleIds: string[];
}

export async function findCategory(guild: Guild, categoryName: string): Promise<CategoryChannel | null> {
    const category = guild.channels.cache.find(
        (channel) => channel.type === ChannelType.GuildCategory && channel.name === categoryName
    ) as CategoryChannel;

    return category || null;
}

export async function findOrCreateModeratorCategory({
    guild,
    categoryName,
    moderationRoleIds,
}: FindOrCreateCategoryOptions) {
    try {
        let category = await findCategory(guild, categoryName);
        if (category) return ok(category);

        const me = guild.members.me!;
        const modRoles = guild.roles.cache.filter((role) => moderationRoleIds.includes(role.id));

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

        return ok(category);
    } catch (err) {
        return fail('Failed to find or create category');
    }
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
    ticketsConfig: ConfiguredTicketingConfig
): Promise<Result<void>> {
    // Find or create the closed tickets category
    const closedCategoryResult = await findOrCreateModeratorCategory({
        guild,
        categoryName: ticketsConfig.closedTicketCategoryName,
        moderationRoleIds: ticketsConfig.moderationRoles,
    });

    if (!closedCategoryResult.ok) return closedCategoryResult;
    const closedCategory = closedCategoryResult.value;

    // Remove view permissions for @everyone
    await channel.permissionOverwrites.edit(guild.roles.everyone.id, {
        ViewChannel: false,
    });

    // Ensure moderators can still access
    await setupModeratorPermissions(channel, guild, ticketsConfig.moderationRoles);

    await channel.setParent(closedCategory);

    return ok();
}

interface ReopenTicketChannelParams {
    ticketsConfig: ConfiguredTicketingConfig;
    channel: TextChannel;
    guild: Guild;
    memberReopeningTicket: GuildMember;
    ticketState: TicketState;
}

/**
 * Reopens a ticket by restoring permissions, channel name, and moving back to active category
 */
export async function reopenTicketChannel({
    ticketsConfig,
    channel,
    guild,
    ticketState,
}: ReopenTicketChannelParams): Promise<Result<void>> {
    const targetUserId = ticketState.targetUserId;

    // Find or create the active tickets category
    const activeCategoryResult = await timeFnCall(
        async () =>
            await findOrCreateModeratorCategory({
                guild,
                categoryName: ticketState.claimedByUserId
                    ? ticketsConfig.claimedTicketCategoryName
                    : ticketsConfig.supportTicketCategoryName,
                moderationRoleIds: ticketsConfig.moderationRoles,
            }),
        'findOrCreateModeratorCategory()'
    );
    if (!activeCategoryResult.ok) return activeCategoryResult;
    const activeCategory = activeCategoryResult.value;

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
    await timeFnCall(async () => await channel.setParent(activeCategory), 'channel.setParent()');

    return ok();
}
