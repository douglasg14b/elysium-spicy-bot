import type { TicketEntity } from './data/ticketsSchema';

/**
 * What the ticket service announces after it changes a ticket, and to whom.
 *
 * Tickets is a base capability: it changes tickets whether or not any feature cares.
 * Flows consumes these announcements to start Ticket Event runs, but tickets imports
 * nothing from flows — each consumer registers itself at wiring time, exactly as
 * `features-system/activity/activitySubscribers.ts` does. With nothing registered, a
 * ticket still changes.
 */

/**
 * The changes a ticket announces.
 *
 * `opened` fires once the ticket has its channel **and its state message** — when the
 * message's id is first recorded — not when the row is created or the channel attached.
 * Before that there is no embed showing the ticket's state, and a flow that heard
 * "opened" and closed the ticket would leave the embed posted afterwards showing it open.
 * So a ticket whose channel or state message could not be made, or whose message id
 * could not be recorded, announces nothing. An auto-claimed ticket announces `opened`
 * only — the type claimed it, nobody did.
 */
export const TICKET_CHANGE_KINDS = ['opened', 'claimed', 'unclaimed', 'closed', 'reopened', 'deleted'] as const;

export type TicketChangeKind = (typeof TICKET_CHANGE_KINDS)[number];

/**
 * Who made a change, and how far down a chain of automated changes it sits — handed to
 * the service by whoever asked for the change.
 *
 * "Chain depth" is a causation idea, not a flows one, so tickets can carry it without
 * learning flows exist: a person's change is depth 0, and automation that changes a
 * ticket passes the depth it was itself started at. A consumer reading the
 * announcement is what decides how deep is too deep.
 */
export interface TicketChange {
    /**
     * The Discord id of whoever made the change: the person, or — when automation did it —
     * the bot's own user. Never absent, so a consumer always has someone to name; a flow
     * that closes a ticket is the bot closing it.
     */
    readonly actorId: string;
    /** 0 for a person's change; the depth of the automation that made it otherwise. */
    readonly chainDepth: number;
}

/** One committed change to a ticket. Announced only after the write succeeded. */
export interface TicketChangeEvent extends TicketChange {
    readonly kind: TicketChangeKind;
    /** The ticket as the write left it. */
    readonly ticket: TicketEntity;
    /** When the change was committed, by the bot's clock. */
    readonly changedAt: Date;
}

export type TicketChangeSubscriber = (event: TicketChangeEvent) => Promise<void> | void;

const registered: TicketChangeSubscriber[] = [];

/**
 * Add a subscriber every committed ticket change should notify.
 *
 * Called once per consumer during feature init. Appends, so a second consumer never
 * evicts the first.
 */
export function registerTicketSubscriber(subscriber: TicketChangeSubscriber): void {
    registered.push(subscriber);
}

/** Remove every subscriber. Test seam; not used in production code. */
export function clearTicketSubscribers(): void {
    registered.length = 0;
}

/**
 * Notify every subscriber, in parallel, and wait for all of them.
 *
 * Each is isolated from the others: one that throws is logged on its own line and
 * neither stops the rest nor unwinds the change — the row is already written, and what
 * a consumer made of it is not the ticket service's concern.
 *
 * **Never call this inside a repo transaction.** A subscriber's first query would wait
 * on SQLite's one connection, which the open transaction is holding.
 */
export async function notifyTicketChange(event: TicketChangeEvent): Promise<void> {
    // Copied, so a registration made while subscribers are running joins the next change
    // rather than this one.
    const subscribers = [...registered];
    const settled = await Promise.allSettled(subscribers.map(async (subscriber) => subscriber(event)));

    for (const outcome of settled) {
        if (outcome.status === 'rejected') {
            console.error(
                `[tickets] Subscriber failed for ${event.kind} on ticket #${event.ticket.ticketNumber} (id ${event.ticket.id}):`,
                outcome.reason
            );
        }
    }
}
