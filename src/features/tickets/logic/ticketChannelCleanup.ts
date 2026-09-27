import { Events, type Client } from 'discord.js';
import { forgetTicketChannel } from '../ticketService';

/**
 * Stop tickets pointing at a channel the moment Discord reports it deleted, by hand or
 * by anyone else.
 *
 * Without this a hand-deleted channel stayed on its ticket, and the dashboard kept
 * offering a link to nothing. This covers deletions while the bot is online; one made
 * while it was offline is caught by the next ticket action, when Discord answers
 * `Unknown Channel` (see `applyTicketTransition`).
 *
 * Takes the client rather than reading `DISCORD_CLIENT`, so a test can attach it to the
 * client it drives. `initTicketsFeature` attaches it to the bot's.
 */
export function registerTicketChannelCleanup(client: Client): void {
    client.on(Events.ChannelDelete, (channel) => {
        if (channel.isDMBased()) return;
        void forgetTicketChannel(channel.id).then((result) => {
            if (!result.ok) {
                console.error(`[tickets] Could not record that channel ${channel.id} was deleted:`, result.error);
            }
        });
    });
}
