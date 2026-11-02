import { z } from 'zod';
import type { FlowStepOutcome } from '../../engine/stepOutcome';
import {
    checkTicketChoice,
    findChosenTicket,
    TICKET_CHOICE_CARD_PART,
    TICKET_CHOICE_FIELD,
    TICKET_ID_FIELD,
    ticketChoiceShape,
} from '../../logic/ticketChoice';
import { ticketSubjectOutputs, writeTicketSubjectOutputs } from '../../logic/ticketSubjectOutputs';
import { TICKET_STATUSES, type TicketStatus } from '../../../tickets';
import type { BlockManifest } from '../manifest';

export const CONDITION_TICKET_STATUS = 'condition.ticketStatus';

/** The exit a run leaves by when the choice names no ticket in this server. */
export const TICKET_STATUS_NO_TICKET_HANDLE = 'noTicket';

/** Which ticket to look at — the shared "Which ticket" choice (`logic/ticketChoice.ts`). */
export const ticketStatusConfigSchema = z
    .object(ticketChoiceShape)
    .superRefine((config, context) => checkTicketChoice(config, context));

export type TicketStatusConfig = z.infer<typeof ticketStatusConfigSchema>;

/** The exit each status leaves by — its own name, so the graph's edge says what it means. */
function exitFor(status: TicketStatus): FlowStepOutcome {
    switch (status) {
        case 'open':
        case 'closed':
        case 'deleted':
            return { kind: 'continue', handle: status };
        default: {
            const illegal: never = status;
            throw new Error(`Unknown ticket status ${JSON.stringify(illegal)}.`);
        }
    }
}

/**
 * Where is a ticket in its life, right now?
 *
 * Finds one ticket the way Close Ticket does — by id, usually `{{var.ticketId}}`, or as the
 * ticket in the run's channel — and leaves by one exit per status, read from the record when
 * the run gets here, so a run that parked for a day sees what happened in that day. A switch
 * rather than "is it X?": one block answers every case.
 *
 * **No ticket** when the choice names none in this server: a channel that is no ticket's, or
 * an id from another server or none at all. Warned about only on "the ticket in this
 * channel", where an ordinary run lands there — any channel can be the one a message was sent
 * in. An id from Open Ticket or Ticket Event always names a ticket, so the warning would sit
 * on every by-id card. Deleted is reachable by id only: a deleted ticket's channel is gone,
 * and a channel lookup leaves deleted tickets out.
 *
 * Lifecycle only. Whether someone has claimed it is a separate fact on the record
 * (`claimerId`), deliberately not folded into status.
 */
export const block: BlockManifest<TicketStatusConfig> = {
    type: CONDITION_TICKET_STATUS,
    kind: 'condition',
    label: 'Ticket Status?',
    description: "Still open, shut, or binned for good? Check where a ticket's at and go a different way for each.",
    group: 'conditions',
    icon: '🎟️',
    configSchema: ticketStatusConfigSchema,
    configFields: [TICKET_CHOICE_FIELD, TICKET_ID_FIELD],
    // "Ticket {{var.ticketId}}", or "The ticket in this channel".
    cardSummary: [TICKET_CHOICE_CARD_PART, { key: 'ticketId', prefix: 'Ticket ', emptyText: 'no ticket picked' }],
    handles: [
        { id: 'open', label: 'Open', tone: 'positive' },
        { id: 'closed', label: 'Closed', tone: 'neutral' },
        { id: 'deleted', label: 'Deleted', tone: 'negative' },
        {
            id: TICKET_STATUS_NO_TICKET_HANDLE,
            label: 'No ticket',
            tone: 'caution',
            warnIfUnconnected: { whenField: TICKET_CHOICE_FIELD.key, equals: ['here'] },
        },
    ],
    // Who the ticket is for, on every exit that found one — not No ticket, which found nothing.
    outputs: [...ticketSubjectOutputs(TICKET_STATUSES)],
    requires: [],
    capabilities: [],
    emits: [],
    canSuspend: false,
    async run(config, context) {
        const chosen = await findChosenTicket(config, context, 'Ticket Status?');
        if (chosen.kind !== 'found') {
            return { kind: 'continue', handle: TICKET_STATUS_NO_TICKET_HANDLE };
        }
        writeTicketSubjectOutputs(context, chosen.ticket.subjectId);
        return exitFor(chosen.ticket.status);
    },
};
