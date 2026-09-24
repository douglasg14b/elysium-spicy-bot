/**
 * How a ticket is written on screen, in one place both pages read.
 *
 * The list and the detail page each render a status badge and a ticket number, and a
 * second copy of either would drift the moment a status gained a colour or the padding
 * changed. A new module rather than an addition to `ticketActions.ts` only because that
 * file and its test are settled; this is the same kind of thing and belongs beside it.
 */

import type { TicketStatus } from '../api/types';

/**
 * The badge colour per status. Narrow rather than `string`, so a typo is a compile error
 * and the union matches `TicketActionPresentation.tone`.
 */
export const TICKET_STATUS_TONE: Readonly<Record<TicketStatus, 'brand' | 'gray' | 'red'>> = {
    open: 'brand',
    closed: 'gray',
    deleted: 'red',
};

/** `#0042`. Padded so the column stays a column and numbers line up by eye. */
export function formatTicketNumber(ticketNumber: number): string {
    return `#${String(ticketNumber).padStart(4, '0')}`;
}
