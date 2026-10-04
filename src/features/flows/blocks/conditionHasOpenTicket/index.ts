import { z } from 'zod';
import type { BlockManifest } from '../manifest';
import { findOpenTicket, TICKET_VARIABLES } from '../../../tickets';

export const CONDITION_HAS_OPEN_TICKET = 'condition.hasOpenTicket';

export const hasOpenTicketConfigSchema = z.object({
    // Free text rather than an enum: a ticket type is a row in the guild's
    // `ticketing_config`, so a closed union in source would reject every type an
    // operator declares. The picker offers the guild's own list; a key it no longer
    // declares is still answered from the records, which may hold tickets of it.
    ticketType: z.string().min(1),
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
            control: 'ticketTypePicker',
        },
    ],
    cardSummary: [{ key: 'ticketType', prefix: 'Open ', emptyText: 'no type picked' }],
    handles: [
        { id: 'true', label: 'Yes', tone: 'positive' },
        { id: 'false', label: 'No', tone: 'negative' },
    ],
    /*
     * The ticket it found, under the names Open Ticket also uses (see
     * `TICKET_VARIABLES`), and only on Yes: on No there is no ticket, and the
     * builder must not offer one there.
     */
    outputs: [
        {
            naming: 'fixed',
            key: TICKET_VARIABLES.ticketId,
            label: 'Ticket ID',
            description: 'The open ticket it found. Their newest, if they have several.',
            handle: 'true',
        },
        {
            naming: 'fixed',
            key: TICKET_VARIABLES.ticketChannelId,
            label: 'Ticket channel',
            description: "The open ticket's channel, so a later block can post in it.",
            valueKind: 'channel',
            handle: 'true',
        },
    ],
    requires: ['subject'],
    capabilities: [],
    canSuspend: false,
    async run(config, context) {
        const ticket = await findOpenTicket(context.guild.id, context.subject.id, config.ticketType);
        if (!ticket) {
            return { kind: 'continue', handle: 'false' };
        }

        context.setOutput(TICKET_VARIABLES.ticketId, ticket.id);
        /*
         * A ticket is a record first and its channel second: one whose channel was
         * deleted is still open, and still a Yes. `null` is written rather than
         * skipping the write, so a channel recorded by an earlier visit or an
         * earlier block cannot survive to pair with this ticket — and a picker
         * reading it fails saying the channel is gone, not that the wiring is wrong.
         */
        context.setOutput(TICKET_VARIABLES.ticketChannelId, ticket.channelId ?? null);

        return { kind: 'continue', handle: 'true' };
    },
};
