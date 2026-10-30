import type { APIEmbed } from 'discord.js';
import { formatDuration } from '../../../utils/formatDuration';
import type { FlashChatSettings } from '../data/flashChatRepo';

/** A channel's timer for a Discord message: `90` → `1m 30s`. */
export function formatFlashChatTimeout(timeoutSeconds: number): string {
    return formatDuration(timeoutSeconds * 1000);
}

/** Posted in the channel when flash chat starts there, or its timer changes. */
export function flashChatEnabledNotice(settings: FlashChatSettings): APIEmbed {
    return {
        title: '⚡ Flash Chat Enabled',
        description: `Messages in this channel will be automatically deleted after **${formatFlashChatTimeout(
            settings.timeoutSeconds,
        )}**`,
        color: 0xffa500,
        footer: {
            text: settings.preservePinned ? 'Pinned messages will be preserved' : 'All messages will be deleted',
        },
    };
}

/** Posted in the channel when flash chat is turned off there. */
export const FLASH_CHAT_DISABLED_NOTICE: APIEmbed = {
    title: '⚡ Flash Chat Disabled',
    description: 'Flash chat has been turned off in this channel.',
    color: 0xff0000,
};
