import { ChannelType, PermissionsBitField, type Guild, type TextChannel } from 'discord.js';
import { verifyCommandPermissions } from '../../../utils';

/** What the bot needs in a channel to watch it and delete from it. */
export const FLASH_CHAT_REQUIRED_PERMISSIONS = [
    PermissionsBitField.Flags.ViewChannel,
    PermissionsBitField.Flags.SendMessages,
    PermissionsBitField.Flags.ManageMessages,
    PermissionsBitField.Flags.ReadMessageHistory,
];

export type FlashChatChannelCheck =
    | { readonly ok: true; readonly channel: TextChannel }
    | { readonly ok: false; readonly message: string };

/**
 * Whether flash chat can run in a channel of this server: a text channel the bot can read,
 * post in and delete from. Asked of the guild's caches, never of Discord, before anything is
 * saved — by the slash command and the dashboard alike, in the same words.
 */
export function checkFlashChatChannel(guild: Guild, channelId: string): FlashChatChannelCheck {
    const channel = guild.channels.cache.get(channelId);
    if (!channel || channel.type !== ChannelType.GuildText) {
        return { ok: false, message: 'Flash chat only works in a text channel in this server.' };
    }

    const me = guild.members.me;
    if (!me) {
        return { ok: false, message: "I can't find myself in this server yet. Give me a second and try again." };
    }

    const missing = verifyCommandPermissions(channel.permissionsFor(me), FLASH_CHAT_REQUIRED_PERMISSIONS);
    if (missing.length > 0) {
        return { ok: false, message: `I'm missing these permissions in #${channel.name}: ${missing.join(', ')}.` };
    }

    return { ok: true, channel };
}
