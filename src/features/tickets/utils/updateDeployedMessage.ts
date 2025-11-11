import { ticketingRepo } from '../data/ticketingRepo';
import { CreateModTicketChannelEmbedComponent } from '../components/createModTicketChannelEmbed';
import { DISCORD_CLIENT } from '../../../discordClient';

/**
 * Updates a deployed ticket system message with the latest configuration
 * @param guildId The Discord guild ID
 */
export async function updateDeployedTicketMessage(guildId: string): Promise<void> {
    try {
        const config = await ticketingRepo.get(guildId);
        const ticketConfig = config?.config;

        if (ticketConfig?.modTicketsDeployedChannelId && ticketConfig?.modTicketsDeployedMessageId) {
            const channelId = ticketConfig.modTicketsDeployedChannelId;
            const messageId = ticketConfig.modTicketsDeployedMessageId;

            const channel = await DISCORD_CLIENT.channels.fetch(channelId);
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
