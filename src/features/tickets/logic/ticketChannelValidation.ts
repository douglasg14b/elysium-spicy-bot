import { ChannelType, TextChannel } from 'discord.js';
import { TICKETING_CONFIG } from '../ticketsConfig';

/**
 * Checks if a channel is a valid ticket channel (active or closed)
 */
export function isTicketChannel(channel: any): channel is TextChannel {
    if (!channel || channel.type !== ChannelType.GuildText) {
        return false;
    }

    // Check if channel name matches ticket pattern (with or without -closed suffix)
    const namePattern = /^s\d+-[^-]+-.*$/;
    const baseName = channel.name.replace(/-closed$/, '');

    if (!namePattern.test(baseName)) {
        return false;
    }

    // Check if it's in either the active or closed ticket category
    const isInActiveCategory = channel.parent?.name === TICKETING_CONFIG.supportTicketCategoryName;
    const isInClosedCategory = channel.parent?.name === TICKETING_CONFIG.closedTicketCategoryName;

    return isInActiveCategory || isInClosedCategory;
}

/**
 * Checks if a channel is a closed ticket channel
 */
export function isClosedTicketChannel(channel: any): channel is TextChannel {
    if (!channel || channel.type !== ChannelType.GuildText) {
        return false;
    }

    // Check if channel name matches ticket pattern and ends with -closed
    const namePattern = /^s\d+-[^-]+-.*-closed$/;

    if (!namePattern.test(channel.name)) {
        return false;
    }

    // Check if it's in the closed ticket category
    return channel.parent?.name === TICKETING_CONFIG.closedTicketCategoryName;
}

/**
 * Checks if a channel is an active (non-closed) ticket channel
 */
export function isActiveTicketChannel(channel: any): channel is TextChannel {
    if (!channel || channel.type !== ChannelType.GuildText) {
        return false;
    }

    // Check if channel name matches ticket pattern and doesn't end with -closed
    const namePattern = /^s\d+-[^-]+-.*$/;

    if (!namePattern.test(channel.name) || channel.name.endsWith('-closed')) {
        return false;
    }

    // Check if it's in the active ticket category
    return channel.parent?.name === TICKETING_CONFIG.supportTicketCategoryName;
}
