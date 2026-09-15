import { z } from 'zod';
import { ChannelType } from 'discord.js';
import type { BlockManifest } from '../manifest';
import { ticketingRepo } from '../../../tickets/data/ticketingRepo';
import { isTicketingConfigConfigured } from '../../../tickets/data/ticketingSchema';
import { closeTicket, getTicket } from '../../../tickets/ticketService';
import { syncTicketChannelToState } from '../../../tickets/logic/ticketChannelOps';

export const ACTION_CLOSE_TICKET = 'action.closeTicket';

export const closeTicketConfigSchema = z.object({
    ticketId: z.string().min(1),
});

export type CloseTicketConfig = z.infer<typeof closeTicketConfigSchema>;

/**
 * Closes a ticket the run is holding.
 *
 * Takes the ticket id as a token — normally `{{var.ticketId}}` from an upstream
 * Open Ticket block. A string rather than a number because that is what a
 * rendered token is; it is parsed here and rejected loudly if it is not one,
 * rather than silently closing ticket `NaN`.
 *
 * The id survives a park, which is the practical reason the record has a stable
 * identity separate from its channel: a run can open a ticket, wait days for a
 * human, and still name the same ticket afterwards even if its channel moved
 * category or was renamed in the meantime.
 */
export const block: BlockManifest<CloseTicketConfig> = {
    type: ACTION_CLOSE_TICKET,
    kind: 'action',
    label: 'Close Ticket',
    description: 'Close a ticket this flow opened earlier.',
    group: 'actions',
    icon: '🔒',
    configSchema: closeTicketConfigSchema,
    configFields: [
        {
            key: 'ticketId',
            label: 'Ticket',
            description: 'Usually {{var.ticketId}} from an earlier Open Ticket block.',
            control: 'text',
            placeholder: '{{var.ticketId}}',
            rendersTokens: true,
        },
    ],
    cardSummary: [{ key: 'ticketId', prefix: 'Closes ', emptyText: 'no ticket picked' }],
    handles: [{ label: 'Then', tone: 'neutral' }],
    outputs: [],
    requires: [],
    capabilities: [],
    canSuspend: false,
    async run(config, context) {
        const ticketId = Number(config.ticketId);
        if (!Number.isInteger(ticketId)) {
            throw new Error(`Close Ticket needs a ticket id, got "${config.ticketId}"`);
        }

        const closed = await closeTicket(ticketId);
        if (!closed.ok) throw closed.error;
        const ticket = closed.value;

        // Moving the channel is a best-effort reflection of a decision that has
        // already been recorded. A ticket whose channel is gone is still closed;
        // the record is the truth and the channel is one of its renderings.
        if (!ticket.channelId) return { kind: 'continue' };

        const configEntity = await ticketingRepo.get(context.guild.id);
        if (!isTicketingConfigConfigured(configEntity)) return { kind: 'continue' };

        const channel = await context.client.channels.fetch(ticket.channelId).catch(() => null);
        if (channel?.type === ChannelType.GuildText) {
            await syncTicketChannelToState(channel, context.guild, ticket, configEntity.config);
        }

        return { kind: 'continue' };
    },
};
