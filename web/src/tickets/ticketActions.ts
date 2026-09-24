import type { TicketAction } from '../api/tickets';
import type { TicketSummary } from '../api/types';

/**
 * Which lifecycle actions a ticket can take, from the row alone.
 *
 * **The same rule `buildTicketButtons` applies in Discord**, in one place the page and
 * its test both read rather than inlined per button: claim needs open-and-unclaimed,
 * unclaim open-and-claimed, close open, reopen closed. A deleted ticket takes none —
 * its channel is gone, so there is nothing left to move.
 *
 * Extracted into a `.ts` module because it is the page's only real decision and there
 * are no `.test.tsx` files in this repo — no jsdom, no testing-library — so logic left
 * inside a component is logic nothing can test.
 *
 * The server stays the authority. This decides what to *offer*; `ticketService` decides
 * what to allow, and it refuses independently. Offering nothing is how an operator is
 * told what state a ticket is in before they press something whose only outcome is a
 * banner.
 *
 * Delete is deliberately absent: it destroys the channel and stays in Discord.
 */
export function availableActions(ticket: Pick<TicketSummary, 'status' | 'claimer'>): TicketAction[] {
    switch (ticket.status) {
        case 'open':
            // Claim and unclaim are driven by the claimer, not by the status, which is
            // what lets an open ticket be released without pretending it is in some
            // other lifecycle state.
            return ticket.claimer ? ['unclaim', 'close'] : ['claim', 'close'];
        case 'closed':
            return ['reopen'];
        case 'deleted':
            return [];
        default: {
            const unhandled: never = ticket.status;
            throw new Error(`Unhandled ticket status: ${String(unhandled)}`);
        }
    }
}

/** How each action is labelled on a button, and how loudly. */
export interface TicketActionPresentation {
    readonly label: string;
    /** `red` for the one that shuts a ticket; the rest are quiet. */
    readonly tone: 'brand' | 'gray' | 'red';
    /** Present tense, for the success notification. */
    readonly done: string;
}

export const TICKET_ACTION_PRESENTATION: Readonly<Record<TicketAction, TicketActionPresentation>> = {
    claim: { label: 'Claim', tone: 'brand', done: 'claimed' },
    unclaim: { label: 'Release', tone: 'gray', done: 'released' },
    close: { label: 'Close', tone: 'red', done: 'closed' },
    reopen: { label: 'Reopen', tone: 'brand', done: 'reopened' },
};
