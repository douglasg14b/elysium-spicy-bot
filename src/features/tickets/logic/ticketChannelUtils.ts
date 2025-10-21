import { Guild, GuildMember, TextChannel } from 'discord.js';
import { TICKETING_CONFIG } from '../ticketsConfig';

/**
 * Extracts ticket information from a ticket channel name
 */
export function parseTicketChannelName(channelName: string): {
    ticketId: string | null;
    targetUsername: string | null;
    creatorUsername: string | null;
    isClosed: boolean;
} {
    // Remove '-closed' suffix if present
    const isClosed = channelName.endsWith('-closed');
    const cleanName = isClosed ? channelName.replace(/-closed$/, '') : channelName;

    // Expected format: s####-username-creator
    const match = cleanName.match(/^s(\d+)-([^-]+)-(.+)$/);

    if (!match) {
        return {
            ticketId: null,
            targetUsername: null,
            creatorUsername: null,
            isClosed,
        };
    }

    return {
        ticketId: match[1],
        targetUsername: match[2],
        creatorUsername: match[3],
        isClosed,
    };
}

/**
 * Attempts to find a guild member by username or display name
 */
export function findMemberByUsername(guild: Guild, username: string): GuildMember | null {
    const normalizedUsername = username.toLowerCase();

    return (
        guild.members.cache.find(
            (member) =>
                member.user.username.toLowerCase() === normalizedUsername ||
                member.displayName.toLowerCase() === normalizedUsername
        ) || null
    );
}

/**
 * Gets the original channel name by removing the '-closed' suffix
 */
export function getOriginalChannelName(channelName: string): string {
    return channelName.endsWith('-closed') ? channelName.replace(/-closed$/, '') : channelName;
}

/**
 * Marks a channel name as closed by adding the '-closed' suffix
 */
export function getClosedChannelName(channelName: string): string {
    // Don't double-suffix if already closed
    if (channelName.endsWith('-closed')) {
        return channelName;
    }
    return `${channelName}-closed`;
}
