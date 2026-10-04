import type { Guild } from 'discord.js';
import { ticketingRepo } from '../data/ticketingRepo';
import { CreateModTicketChannelEmbedComponent } from '../components/createModTicketChannelEmbed';

/**
 * Updates a deployed ticket system message with the latest configuration.
 *
 * Takes the guild its caller already holds — the interaction's, or the one the route's
 * guild access check resolved — and finds the panel's channel through it.
 *
 * @param guild The guild whose deployed panel is redrawn
 */
export async function updateDeployedTicketMessage(guild: Guild): Promise<void> {
    try {
        const config = await ticketingRepo.get(guild.id);
        const ticketConfig = config?.config;

        if (ticketConfig?.modTicketsDeployedChannelId && ticketConfig?.modTicketsDeployedMessageId) {
            const channelId = ticketConfig.modTicketsDeployedChannelId;
            const messageId = ticketConfig.modTicketsDeployedMessageId;

            const channel = await guild.channels.fetch(channelId);
            if (channel?.isTextBased()) {
                const message = await channel.messages.fetch(messageId);

                // Generate updated embed with new configuration
                const embedComponent = CreateModTicketChannelEmbedComponent(config || undefined);
                const messageData = embedComponent.messageEmbed;

                await message.edit(messageData);
            }
        }
    } catch (error) {
        console.warn('Failed to update deployed ticket message:', error);
        // Don't throw the error - this should not fail the calling operation
    }
}
