import { fail, ok, type Result } from '../../shared';
import { ticketingRepo } from './data/ticketingRepo';
import { ticketsRepo } from './data/ticketsRepo';
import type { TicketEntity, TicketType } from './data/ticketsSchema';
import { getTicketTypeDefinition } from './logic/ticketTypes';

/**
 * The ticket system's own surface, owing nothing to Discord interactions or to
 * flows.
 *
 * This module is the actual deliverable of the ticket work. Everything the old
 * code could do already existed, but only ever reachable *through* a
 * `ButtonInteraction` or a `ModalSubmitInteraction` — `createTicketChannel` took
 * an interaction as its first argument and read the guild, the opener and the
 * member out of it. A flow has no interaction, so none of that logic was
 * callable by one. Lifting the decisions here is what makes tickets a base
 * capability with flows as a consumer, rather than a Discord handler with
 * behaviour trapped inside it.
 *
 * Two rules hold this boundary, and both are load-bearing:
 *
 *   1. **Nothing here imports from `src/features/flows/`.** A dependency in that
 *      direction is precisely the defect this design exists to prevent. Flows
 *      may call tickets; tickets must never know flows exist.
 *   2. **Nothing here takes or returns a discord.js interaction.** Channel
 *      effects live in the Discord-facing layer that calls this; the decisions
 *      — may this be claimed, what does closing mean, which number is next —
 *      live here where they can be tested without a gateway.
 *
 * The state transitions below are the part worth reading carefully. Previously
 * they were implied by an enum where claiming moved a ticket out of `active`,
 * so "claimed" and "open" could not be distinguished. Here lifecycle and
 * ownership are independent, and each transition states what it refuses.
 */

export interface OpenTicketInput {
    readonly guildId: string;
    readonly type: TicketType;
    readonly subjectId: string;
    /** Null when a flow opens the ticket and no human filed it. */
    readonly openerId: string | null;
    readonly title: string;
    readonly reason: string;
}

/**
 * Allocates the next ticket number for a guild, atomically.
 *
 * Uses the repo's `UPDATE ... SET n = n + 1 RETURNING`, which has existed
 * unused since it was written. The path it replaces incremented the counter in
 * memory, awaited a channel creation round trip to Discord, and only then
 * persisted — so two moderators filing within that window both received the same
 * number and the second write silently overwrote the first. The window was not a
 * few instructions; it spanned a network call.
 *
 * Called before any channel exists, so a failure here costs nothing but an error
 * message.
 */
async function allocateTicketNumber(guildId: string): Promise<Result<number>> {
    try {
        return ok(await ticketingRepo.incrementTicketNumber(guildId));
    } catch (error) {
        return fail(error instanceof Error ? error : new Error(String(error)));
    }
}

/**
 * Opens a ticket as a record.
 *
 * Returns before any channel exists. That ordering is deliberate: the record is
 * the ticket and the channel is something it acquires, so a caller that fails to
 * create a channel leaves a ticket with `channelId` null rather than a channel
 * with no record. The reverse — the old model — had no way to represent a
 * half-made ticket at all, because the embed *was* the state.
 */
export async function openTicket(input: OpenTicketInput): Promise<Result<TicketEntity>> {
    const definition = getTicketTypeDefinition(input.type);

    const numberResult = await allocateTicketNumber(input.guildId);
    if (!numberResult.ok) return numberResult;

    const now = new Date().toISOString();
    const claimerId = definition.autoClaimOnOpen ? input.openerId : null;

    try {
        const ticket = await ticketsRepo.create({
            guildId: input.guildId,
            ticketNumber: numberResult.value,
            type: input.type,
            status: 'open',
            subjectId: input.subjectId,
            openerId: input.openerId,
            claimerId,
            channelId: null,
            title: input.title,
            reason: input.reason,
            openedAt: now,
            claimedAt: claimerId ? now : null,
            closedAt: null,
            deletedAt: null,
            updatedAt: now,
        });

        return ok(ticket);
    } catch (error) {
        return fail(error instanceof Error ? error : new Error(String(error)));
    }
}

/**
 * Records the channel a ticket now lives in.
 *
 * Separate from {@link openTicket} because the channel is an output of creating
 * one, not an input to opening a ticket.
 */
export async function attachTicketChannel(ticketId: number, channelId: string): Promise<Result<TicketEntity>> {
    try {
        return ok(await ticketsRepo.update(ticketId, { channelId }));
    } catch (error) {
        return fail(error instanceof Error ? error : new Error(String(error)));
    }
}

export async function claimTicket(ticketId: number, claimerId: string): Promise<Result<TicketEntity>> {
    const ticket = await ticketsRepo.getById(ticketId);
    if (!ticket) return fail(`No ticket found with id ${ticketId}`);

    if (ticket.status !== 'open') {
        return fail(`Ticket #${ticket.ticketNumber} is ${ticket.status} and cannot be claimed.`);
    }

    if (ticket.claimerId === claimerId) {
        return fail(`Ticket #${ticket.ticketNumber} is already claimed by you.`);
    }

    if (ticket.claimerId) {
        return fail(`Ticket #${ticket.ticketNumber} is already claimed by someone else.`);
    }

    try {
        // The read above produces the specific message; this write is what
        // actually decides. Two moderators pressing Claim together both pass the
        // read, and the second gets nothing back from the conditional update
        // rather than silently overwriting the first.
        const claimed = await ticketsRepo.claimIfUnclaimed(ticketId, claimerId, new Date().toISOString());
        if (!claimed) {
            return fail(`Ticket #${ticket.ticketNumber} was just claimed by someone else.`);
        }

        return ok(claimed);
    } catch (error) {
        return fail(error instanceof Error ? error : new Error(String(error)));
    }
}

/**
 * Releases a claim without changing the lifecycle.
 *
 * Only expressible because ownership and lifecycle are separate columns. Under
 * the old enum, unclaiming meant moving back to `active`, which is why "is it
 * claimed" and "is it open" could not be asked independently.
 */
export async function unclaimTicket(ticketId: number): Promise<Result<TicketEntity>> {
    const ticket = await ticketsRepo.getById(ticketId);
    if (!ticket) return fail(`No ticket found with id ${ticketId}`);

    if (!ticket.claimerId) {
        return fail(`Ticket #${ticket.ticketNumber} is not claimed.`);
    }

    try {
        return ok(await ticketsRepo.update(ticketId, { claimerId: null, claimedAt: null }));
    } catch (error) {
        return fail(error instanceof Error ? error : new Error(String(error)));
    }
}

/**
 * Closes a ticket, leaving the claim intact.
 *
 * The claimer is kept on purpose: "who handled this" is a fact about a finished
 * ticket, and clearing it on close would destroy the only record of it.
 */
export async function closeTicket(ticketId: number): Promise<Result<TicketEntity>> {
    const ticket = await ticketsRepo.getById(ticketId);
    if (!ticket) return fail(`No ticket found with id ${ticketId}`);

    if (ticket.status === 'closed') {
        return fail(`Ticket #${ticket.ticketNumber} is already closed.`);
    }

    if (ticket.status === 'deleted') {
        return fail(`Ticket #${ticket.ticketNumber} has been deleted and cannot be closed.`);
    }

    try {
        // Guarded on `open` so a close racing a delete cannot land on top of it
        // and leave a row that is `closed` but carries `deletedAt`.
        const closed = await ticketsRepo.transitionStatus(ticketId, 'open', {
            status: 'closed',
            closedAt: new Date().toISOString(),
        });
        if (!closed) {
            return fail(`Ticket #${ticket.ticketNumber} changed state before it could be closed.`);
        }

        return ok(closed);
    } catch (error) {
        return fail(error instanceof Error ? error : new Error(String(error)));
    }
}

export async function reopenTicket(ticketId: number): Promise<Result<TicketEntity>> {
    const ticket = await ticketsRepo.getById(ticketId);
    if (!ticket) return fail(`No ticket found with id ${ticketId}`);

    if (ticket.status !== 'closed') {
        return fail(`Ticket #${ticket.ticketNumber} is ${ticket.status} and cannot be reopened.`);
    }

    try {
        const reopened = await ticketsRepo.transitionStatus(ticketId, 'closed', { status: 'open', closedAt: null });
        if (!reopened) {
            return fail(`Ticket #${ticket.ticketNumber} changed state before it could be reopened.`);
        }

        return ok(reopened);
    } catch (error) {
        return fail(error instanceof Error ? error : new Error(String(error)));
    }
}

/**
 * Marks a ticket deleted without removing the row.
 *
 * A delete *trigger* cannot fire on a row that no longer exists, and the record
 * has to survive to answer "did this member ever have a verification ticket?"
 * after its channel is long gone. `channelId` is cleared because the channel
 * genuinely stops existing; the rest of the record stays.
 */
export async function deleteTicket(ticketId: number): Promise<Result<TicketEntity>> {
    const ticket = await ticketsRepo.getById(ticketId);
    if (!ticket) return fail(`No ticket found with id ${ticketId}`);

    if (ticket.status === 'deleted') {
        return fail(`Ticket #${ticket.ticketNumber} is already deleted.`);
    }

    try {
        // Guarded on the status just read rather than on a single expected one,
        // because deleting is legal from both `open` and `closed`.
        const deleted = await ticketsRepo.transitionStatus(ticketId, ticket.status, {
            status: 'deleted',
            deletedAt: new Date().toISOString(),
            channelId: null,
        });
        if (!deleted) {
            return fail(`Ticket #${ticket.ticketNumber} changed state before it could be deleted.`);
        }

        return ok(deleted);
    } catch (error) {
        return fail(error instanceof Error ? error : new Error(String(error)));
    }
}

/**
 * Answers "does this member have an open ticket of type X?" with one indexed
 * query and no Discord call.
 *
 * The question this whole table exists for. The old answer was: list channels,
 * filter by a name regex, fetch pinned messages, decode a base64 blob — several
 * rate-limited calls, per member, with an unpredictable cost because the state
 * message lookup had a three-tier fallback.
 */
export async function hasOpenTicket(guildId: string, subjectId: string, type?: TicketType): Promise<boolean> {
    return ticketsRepo.hasOpenBySubject(guildId, subjectId, type);
}

export async function getTicketByChannel(channelId: string): Promise<TicketEntity | null> {
    return ticketsRepo.getByChannelId(channelId);
}

export async function getTicket(ticketId: number): Promise<TicketEntity | null> {
    return ticketsRepo.getById(ticketId);
}
