import { CategoryChannel, ChannelType, Guild, PermissionsBitField, type OverwriteResolvable } from 'discord.js';

interface CreateTicketCategoryOptions {
    readonly guild: Guild;
    readonly name: string;
    readonly moderationRoleIds: readonly string[];
}

/**
 * Make a ticket category: hidden from everyone, open to the bot and the moderation roles.
 *
 * Creates only. It never looks for an existing category, by name or otherwise: finding a
 * category by `channel.name` was issue #22, and every caller now holds an id. The two
 * callers are the dashboard, when an operator types a new name into a slot, and
 * `resolveTicketCategory`, when a bound category has been deleted.
 *
 * Every overwrite goes in the one `channels.create` call. The old version created the
 * category and then added each moderation role separately, so there was a moment when
 * the category existed and the moderators could not see it, and a failure partway left
 * it half-permissioned.
 */
export async function createTicketCategory({
    guild,
    name,
    moderationRoleIds,
}: CreateTicketCategoryOptions): Promise<CategoryChannel> {
    const me = guild.members.me;
    if (!me) {
        throw new Error('Bot member is not resolvable in this guild; refusing to create a ticket category');
    }

    const overwrites: OverwriteResolvable[] = [
        { id: guild.roles.everyone.id, deny: [PermissionsBitField.Flags.ViewChannel] },
        {
            id: me.id,
            allow: [
                PermissionsBitField.Flags.ViewChannel,
                PermissionsBitField.Flags.ManageChannels,
                PermissionsBitField.Flags.ReadMessageHistory,
                PermissionsBitField.Flags.SendMessages,
            ],
        },
    ];

    for (const roleId of moderationRoleIds) {
        if (!guild.roles.cache.has(roleId)) continue;
        overwrites.push({
            id: roleId,
            allow: [
                PermissionsBitField.Flags.ViewChannel,
                PermissionsBitField.Flags.SendMessages,
                PermissionsBitField.Flags.ReadMessageHistory,
                PermissionsBitField.Flags.ManageMessages,
            ],
        });
    }

    return guild.channels.create({ name, type: ChannelType.GuildCategory, permissionOverwrites: overwrites });
}
