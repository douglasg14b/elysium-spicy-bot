import { z } from 'zod';
import type { BlockManifest } from '../manifest';
import { TICKET_TYPES } from '../../../tickets/data/ticketsSchema';
import { hasOpenTicket } from '../../../tickets/ticketService';

export const CONDITION_HAS_OPEN_TICKET = 'condition.hasOpenTicket';

export const hasOpenTicketConfigSchema = z.object({
    ticketType: z.enum(TICKET_TYPES),
});

export type HasOpenTicketConfig = z.infer<typeof hasOpenTicketConfigSchema>;

/**
 * Splits on whether the subject already has an open ticket of a given type.
 *
 * The block this whole ticket redesign exists to make cheap. Asking this before
 * meant listing the guild's channels, filtering them by a name pattern, fetching
 * pinned messages and decoding a base64 blob — several rate-limited API calls,
 * paid *per member*, with an unpredictable cost because the state lookup fell
 * back through a cache, then pins, then the last ten messages. On a
 * `memberJoin`-rooted flow that is charged for everyone who walks in.
 *
 * It is now one indexed query against a covering index, and no Discord call at
 * all.
 *
 * Note the import direction: this reaches into the ticket service, and nothing
 * under `src/features/tickets/` reaches back. Tickets are a base capability;
 * flows are a consumer of one.
 */
export const block: BlockManifest<HasOpenTicketConfig> = {
    type: CONDITION_HAS_OPEN_TICKET,
    kind: 'condition',
    label: 'Has Open Ticket?',
    description: 'Split the path on whether they already have a ticket open.',
    group: 'conditions',
    icon: '🎫',
    configSchema: hasOpenTicketConfigSchema,
    configFields: [
        {
            key: 'ticketType',
            label: 'Ticket type',
            description: 'Which kind of ticket to look for. Only open tickets count.',
            control: 'select',
            options: [
                { value: 'support', label: 'Support' },
                { value: 'verification', label: 'Verification' },
            ],
        },
    ],
    cardSummary: [{ key: 'ticketType', prefix: 'Open ', emptyText: 'no type picked' }],
    handles: [
        { id: 'true', label: 'Yes', tone: 'positive' },
        { id: 'false', label: 'No', tone: 'negative' },
    ],
    outputs: [],
    requires: ['subject'],
    capabilities: [],
    canSuspend: false,
    async run(config, context) {
        const open = await hasOpenTicket(context.guild.id, context.subject.id, config.ticketType);

        return { kind: 'continue', handle: open ? 'true' : 'false' };
    },
};
