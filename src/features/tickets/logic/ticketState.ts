import {
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    User,
    Guild,
    TextChannel,
    Message,
    APIEmbedField,
} from 'discord.js';
import {
    TicketClaimButtonComponent,
    TicketUnclaimButtonComponent,
    TicketCloseButtonComponent,
    TicketDeleteButtonComponent,
    TicketReopenButtonComponent,
} from '../components';
import NodeCache from 'node-cache';

export interface TicketState {
    ticketId: string;
    targetUserId: string;
    creatorUserId: string;
    title: string;
    reason: string;
    status: 'active' | 'claimed' | 'closed';
    claimedByUserId?: string;
    createdAt: Date;
    updatedAt: Date;
}

const TTL_SECONDS = 60 * 60 * 48; // 48 hours
const CACHE_POLLING_INTERVAL_SECONDS = 60 * 60; // 60 minutes

const ticketChannelStateMessageIdCache = new NodeCache({
    stdTTL: TTL_SECONDS,
    checkperiod: CACHE_POLLING_INTERVAL_SECONDS,
});

/**
 * Creates the hidden ticket state data for embed fields (base64 encoded)
 */
export function createTicketStateData(state: TicketState): string {
    const jsonData = JSON.stringify({
        id: state.ticketId,
        target: state.targetUserId,
        creator: state.creatorUserId,
        title: state.title,
        reason: state.reason,
        status: state.status,
        claimedBy: state.claimedByUserId,
        created: state.createdAt.toISOString(),
        updated: state.updatedAt.toISOString(),
    });

    // Base64 encode the JSON to make it less intimidating to users
    return Buffer.from(jsonData, 'utf8').toString('base64');
}

/**
 * Parses ticket state data from embed field value (base64 decoded)
 */
export function parseTicketStateData(stateData: string): TicketState | null {
    try {
        // Base64 decode the data first
        const jsonData = Buffer.from(stateData, 'base64').toString('utf8');
        const data = JSON.parse(jsonData);
        return {
            ticketId: data.id,
            targetUserId: data.target,
            creatorUserId: data.creator,
            title: data.title,
            reason: data.reason,
            status: data.status,
            claimedByUserId: data.claimedBy,
            createdAt: new Date(data.created),
            updatedAt: new Date(data.updated),
        };
    } catch (error) {
        console.error('Failed to parse ticket state data:', error);
        return null;
    }
}

/**
 * Creates the main ticket embed with state data
 */
export function createTicketEmbed(
    state: TicketState,
    targetUser: User,
    creatorUser: User,
    claimedUser?: User
): EmbedBuilder {
    const embed = new EmbedBuilder()
        .setTitle(`🎫 Ticket #${state.ticketId}`)
        .setDescription(`**Title:** ${state.title}`)
        .addFields(
            { name: '👤 Target User', value: `${targetUser} (${targetUser.tag})`, inline: true },
            { name: '👮 Created By', value: `${creatorUser} (${creatorUser.tag})`, inline: true }
        )
        .setTimestamp(state.createdAt);

    // Add status field based on ticket state
    let statusText = '';
    let color = 0xff9900; // Default orange

    switch (state.status) {
        case 'active':
            statusText = '🟢 Active';
            color = 0x00ff00;
            break;
        case 'claimed':
            statusText = `🔒 Claimed${claimedUser ? ` by ${claimedUser.tag}` : ''}`;
            color = 0xffff00;
            break;
        case 'closed':
            statusText = '🔴 Closed';
            color = 0xff0000;
            break;
    }

    embed.addFields(
        { name: '📊 Status', value: statusText, inline: true },
        { name: '📝 Reason', value: state.reason, inline: false }
    );

    // Add hidden state data field (base64 encoded for less intimidation)
    embed.addFields({
        name: '🔧 Internal Data',
        value: `\`${createTicketStateData(state)}\``,
        inline: false,
    });

    embed.setColor(color);

    return embed;
}

/**
 * Creates action buttons for ticket management using shared button configurations
 */
export function createTicketActionButtons(state: TicketState): ActionRowBuilder<ButtonBuilder>[] {
    // Button enabled states based on ticket status
    const claimEnabled = state.status !== 'closed' && !state.claimedByUserId; // Only claimable if not closed and unclaimed
    const unclaimEnabled = state.status === 'claimed' && !!state.claimedByUserId; // Only unclaimable if claimed
    const closeEnabled = state.status !== 'closed'; // Can close if active or claimed
    const reopenEnabled = state.status === 'closed'; // Only reopenable if closed
    const deleteEnabled = true; // Always enabled

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        TicketClaimButtonComponent().component(claimEnabled) as ButtonBuilder,
        TicketUnclaimButtonComponent().component(unclaimEnabled) as ButtonBuilder,
        TicketCloseButtonComponent().component(closeEnabled) as ButtonBuilder,
        TicketReopenButtonComponent().component(reopenEnabled) as ButtonBuilder,
        TicketDeleteButtonComponent().component(deleteEnabled) as ButtonBuilder
    );

    return [row];
}

function isMessageTicketStateEmbed(message: Message): APIEmbedField | false {
    if (message.embeds.length === 0) {
        return false;
    }

    const embed = message.embeds[0];
    const stateField = embed.fields?.find((field) => field.name === '🔧 Internal Data');

    return stateField || false;
}

function extractTicketEmbedData(stateField: APIEmbedField): TicketState | null {
    try {
        // Extract base64 data from code block
        const base64Match = stateField.value.match(/`([A-Za-z0-9+/=]+)`/);
        if (base64Match) {
            const state = parseTicketStateData(base64Match[1]);
            return state;
        }
        return null;
    } catch (error) {
        console.error('Error extracting ticket embed data:', error);
        return null;
    }
}

async function findPinnedTicketStateMessage(
    channel: TextChannel
): Promise<{ message: any; state: TicketState } | null> {
    try {
        const pinnedMessages = await channel.messages.fetchPinned();

        for (const message of pinnedMessages.values()) {
            const stateField = isMessageTicketStateEmbed(message);
            if (stateField) {
                const state = extractTicketEmbedData(stateField);
                if (state) {
                    return { message, state };
                }
            }
        }

        return null;
    } catch (error) {
        console.error('Error finding pinned ticket state message:', error);
        return null;
    }
}

async function tryGetTicketStateFromViaCache(
    channel: TextChannel
): Promise<{ message: any; state: TicketState } | null> {
    try {
        const cachedMessageId = ticketChannelStateMessageIdCache.get<string>(channel.id);
        if (cachedMessageId) {
            const message = await channel.messages.fetch(cachedMessageId);
            const stateField = isMessageTicketStateEmbed(message);
            if (stateField) {
                const state = extractTicketEmbedData(stateField);
                if (state) {
                    return { message, state };
                }
            }
        }
        return null;
    } catch (error) {
        console.error('Error trying to get ticket state from cache:', error);
        return null;
    }
}

/**
 * Finds the ticket state embed in a channel
 */
export async function findTicketStateMessage(
    channel: TextChannel
): Promise<{ message: any; state: TicketState } | null> {
    try {
        // First try via cache
        const foundViaCache = await tryGetTicketStateFromViaCache(channel);
        if (foundViaCache) {
            ticketChannelStateMessageIdCache.set(channel.id, foundViaCache.message.id);
            return foundViaCache;
        }

        // Next try via pinned messages
        const foundByPinned = await findPinnedTicketStateMessage(channel);
        if (foundByPinned) {
            ticketChannelStateMessageIdCache.set(channel.id, foundByPinned.message.id);
            return foundByPinned;
        }

        const messages = await channel.messages.fetch({ limit: 10 });

        for (const message of messages.values()) {
            const stateField = isMessageTicketStateEmbed(message);
            if (stateField) {
                const state = extractTicketEmbedData(stateField);
                if (state) {
                    ticketChannelStateMessageIdCache.set(channel.id, message.id);
                    return { message, state };
                }
            }
        }

        return null;
    } catch (error) {
        console.error('Error finding ticket state message:', error);
        return null;
    }
}

/**
 * Updates the ticket state and refreshes the embed and buttons
 */
export async function updateTicketState(
    channel: TextChannel,
    newState: Partial<TicketState>,
    guild: Guild
): Promise<TicketState | null> {
    try {
        const stateInfo = await findTicketStateMessage(channel);
        if (!stateInfo) {
            console.error('Could not find ticket state message');
            return null;
        }

        const updatedState: TicketState = {
            ...stateInfo.state,
            ...newState,
            updatedAt: new Date(),
        };

        // Get users for embed
        const targetUser = await guild.members.fetch(updatedState.targetUserId);
        const creatorUser = await guild.members.fetch(updatedState.creatorUserId);
        let claimedUser;
        if (updatedState.claimedByUserId) {
            claimedUser = await guild.members.fetch(updatedState.claimedByUserId);
        }

        // Create updated embed and buttons
        const embed = createTicketEmbed(updatedState, targetUser.user, creatorUser.user, claimedUser?.user);
        const buttons = createTicketActionButtons(updatedState);

        // Update the message
        await stateInfo.message.edit({
            embeds: [embed],
            components: buttons,
        });

        return updatedState;
    } catch (error) {
        console.error('Error updating ticket state:', error);
        return null;
    }
}
