import { Guild, PermissionsBitField, CategoryChannel, ChannelType } from 'discord.js';
import { fail, ok } from '../../../shared';

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
