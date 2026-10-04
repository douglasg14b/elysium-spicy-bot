import { fail, ok, type Result } from '../../shared';
import { ticketingRepo } from './data/ticketingRepo';
import { ticketsRepo } from './data/ticketsRepo';
import type { TicketTypeDefinition } from './data/ticketingSchema';
import type { TicketEntity, TicketIdentity, TicketType } from './data/ticketsSchema';
import { notifyTicketChange, type TicketChange, type TicketChangeKind } from './ticketChanges';

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
 *
 * Every change that commits is announced to `ticketChanges.ts`'s subscribers —
 * from here rather than from `applyTicketTransition`, which never sees an open, a
 * delete, or Close Ticket's direct-close fallback. Announced only once the write has
 * returned, and never inside a transaction. Each announcing change requires a
 * {@link TicketChange} saying who made it and how deep in a chain of automated
 * changes it sits; the caller knows both and the service does not, so there is no
 * default for a caller to fall back on by forgetting.
 */

/**
 * Tell subscribers about a change that has committed. Awaited, so a caller's
 * next step sees subscribers' synchronous work done; a subscriber that wants to do
 * slow work schedules it itself.
 */
async function announce(kind: TicketChangeKind, ticket: TicketEntity, change: TicketChange): Promise<void> {
    await notifyTicketChange({
        kind,
        ticket,
        actorId: change.actorId,
        chainDepth: change.chainDepth,
        changedAt: new Date(),
    });
}

export interface OpenTicketInput {
    readonly guildId: string;
    readonly type: TicketType;
    /**
     * The guild's declaration for `type`, resolved by the caller.
     *
     * Passed in rather than looked up, because the service must not read
     * `ticketing_config` to answer "does this type auto-claim" when the caller
     * already read it to find the category. It also keeps this module's stated
     * rule intact: it decides, and a decision made from data handed to it is
     * testable without a database.
     */
    readonly definition: TicketTypeDefinition;
    readonly subjectId: string;
    /** Null when a flow opens the ticket and no human filed it. */
    readonly openerId: string | null;
    readonly title: string;
    readonly reason: string;
    /** Who these people were at open. An unresolvable person yields null, never a placeholder. */
    readonly subjectIdentity: TicketIdentity | null;
    readonly openerIdentity: TicketIdentity | null;
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
    const numberResult = await allocateTicketNumber(input.guildId);
    if (!numberResult.ok) return numberResult;

    const now = new Date().toISOString();
    const claimerId = input.definition.autoClaimOnOpen ? input.openerId : null;
    // An auto-claim makes the opener the claimer, so it records the opener's
    // names under the claimer's columns too. Derived from the same identity
    // rather than re-resolved, so the two cannot disagree about one person.
    const claimerIdentity = claimerId ? input.openerIdentity : null;

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
            subjectUsername: input.subjectIdentity?.username ?? null,
            subjectNickname: input.subjectIdentity?.nickname ?? null,
            openerUsername: input.openerIdentity?.username ?? null,
            openerNickname: input.openerIdentity?.nickname ?? null,
            claimerUsername: claimerIdentity?.username ?? null,
            claimerNickname: claimerIdentity?.nickname ?? null,
            stateMessageId: null,
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
 *
 * **Silent.** The ticket is not announced as opened yet: its state message — the embed
 * with Claim and Close on it — does not exist until after this, and a flow that heard
 * "opened" here and closed the ticket would leave that embed, posted afterwards,
 * showing a closed ticket as open. {@link recordTicketStateMessage} announces instead.
 *
 * Only an open ticket with no channel recorded can be attached, so a second attach
 * fails rather than overwriting the first.
 */
export async function attachTicketChannel(ticketId: number, channelId: string): Promise<Result<TicketEntity>> {
    let attached: TicketEntity | null;
    try {
        attached = await ticketsRepo.attachChannelIfUnattached(ticketId, channelId);
    } catch (error) {
        return fail(error instanceof Error ? error : new Error(String(error)));
    }

    if (!attached) {
        return fail(`Ticket ${ticketId} does not exist, is not open, or already has a channel.`);
    }

    return ok(attached);
}

/**
 * Records that a channel no longer exists in Discord, on the tickets that named it.
 *
 * The record outlives its channel (`channelId` is nullable for exactly this), so the
 * ticket keeps its status and simply stops pointing at something that is not there;
 * surfaces then say the channel is gone instead of linking to it. Called by whoever
 * learns of it first: the gateway's channel delete while the bot is online, or a ticket
 * action that asks Discord for the channel and is told it is unknown.
 *
 * An empty list is the ordinary answer for a channel that was never a ticket's, and for
 * one `deleteTicket` already detached before deleting it.
 */
export async function forgetTicketChannel(channelId: string): Promise<Result<TicketEntity[]>> {
    try {
        return ok(await ticketsRepo.clearChannel(channelId));
    } catch (error) {
        return fail(error instanceof Error ? error : new Error(String(error)));
    }
}

/**
 * Records which in-channel message renders this ticket's state.
 *
 * Separate from {@link attachTicketChannel} because the message is sent *after*
 * the channel exists, and a caller that fails to send one leaves a ticket with a
 * channel and no rendering — which is recoverable — rather than no ticket.
 *
 * A caller with no interaction to re-render from resolves the message by this id,
 * so it is written at open rather than left null for a later consumer to
 * discover it never arrives.
 *
 * **This is where a ticket is announced as `opened`** — not in {@link openTicket},
 * which returns before any channel exists, and not in {@link attachTicketChannel},
 * which returns before the embed does. Once this has run the ticket has a channel and
 * an embed showing its state, so a flow that hears "opened" and closes it re-renders
 * an embed that is already there. A ticket whose channel or state message fails to be
 * made — or whose message id cannot be recorded — announces nothing; its creator
 * reports the failure.
 *
 * Only an open ticket with no state message recorded can be given one, so a second
 * record fails rather than announcing the same ticket twice.
 */
export async function recordTicketStateMessage(
    ticketId: number,
    stateMessageId: string,
    change: TicketChange
): Promise<Result<TicketEntity>> {
    let recorded: TicketEntity | null;
    try {
        recorded = await ticketsRepo.recordStateMessageIfUnrecorded(ticketId, stateMessageId);
    } catch (error) {
        return fail(error instanceof Error ? error : new Error(String(error)));
    }

    if (!recorded) {
        return fail(`Ticket ${ticketId} does not exist, is not open, or already has a state message.`);
    }

    await announce('opened', recorded, change);
    return ok(recorded);
}

/**
 * Claims a ticket for `claimerId`.
 *
 * The announced actor is `change.actorId`, not the claimer: the two agree for every
 * claim made today, but a claim a flow made would name the bot as claimer, and the bot
 * is not a person who acted.
 */
export async function claimTicket(
    ticketId: number,
    claimerId: string,
    identity: TicketIdentity | null,
    change: TicketChange
): Promise<Result<TicketEntity>> {
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

    let claimed: TicketEntity | null;
    try {
        // The read above produces the specific message; this write is what
        // actually decides. Two moderators pressing Claim together both pass the
        // read, and the second gets nothing back from the conditional update
        // rather than silently overwriting the first.
        claimed = await ticketsRepo.claimIfUnclaimed(ticketId, claimerId, new Date().toISOString(), identity);
    } catch (error) {
        return fail(error instanceof Error ? error : new Error(String(error)));
    }

    if (!claimed) {
        return fail(`Ticket #${ticket.ticketNumber} was just claimed by someone else.`);
    }

    await announce('claimed', claimed, change);
    return ok(claimed);
}

/**
 * Releases a claim without changing the lifecycle.
 *
 * Only expressible because ownership and lifecycle are separate columns. Under
 * the old enum, unclaiming meant moving back to `active`, which is why "is it
 * claimed" and "is it open" could not be asked independently.
 *
 * Clears the claimer's names with the claim. A released ticket keeps no claimer,
 * so it keeps no claimer name; "who handled this" survives on a *closed* ticket
 * because closing keeps the claim, which is the rule {@link closeTicket} already
 * states.
 */
export async function unclaimTicket(ticketId: number, change: TicketChange): Promise<Result<TicketEntity>> {
    const ticket = await ticketsRepo.getById(ticketId);
    if (!ticket) return fail(`No ticket found with id ${ticketId}`);

    if (!ticket.claimerId) {
        return fail(`Ticket #${ticket.ticketNumber} is not claimed.`);
    }

    let released: TicketEntity | null;
    try {
        // Guarded on the claimer just read, as claim and the lifecycle moves are guarded
        // on what they read. Unguarded, two releases racing would both write and both
        // announce, and a release that read a stale claim would wipe a fresh one.
        released = await ticketsRepo.releaseClaimIf(ticketId, ticket.claimerId);
    } catch (error) {
        return fail(error instanceof Error ? error : new Error(String(error)));
    }

    if (!released) {
        return fail(`Ticket #${ticket.ticketNumber} changed before it could be unclaimed.`);
    }

    await announce('unclaimed', released, change);
    return ok(released);
}

/**
 * Closes a ticket, leaving the claim intact.
 *
 * The claimer is kept on purpose: "who handled this" is a fact about a finished
 * ticket, and clearing it on close would destroy the only record of it.
 */
export async function closeTicket(ticketId: number, change: TicketChange): Promise<Result<TicketEntity>> {
    const ticket = await ticketsRepo.getById(ticketId);
    if (!ticket) return fail(`No ticket found with id ${ticketId}`);

    if (ticket.status === 'closed') {
        return fail(`Ticket #${ticket.ticketNumber} is already closed.`);
    }

    if (ticket.status === 'deleted') {
        return fail(`Ticket #${ticket.ticketNumber} has been deleted and cannot be closed.`);
    }

    let closed: TicketEntity | null;
    try {
        // Guarded on `open` so a close racing a delete cannot land on top of it
        // and leave a row that is `closed` but carries `deletedAt`.
        closed = await ticketsRepo.transitionStatus(ticketId, 'open', {
            status: 'closed',
            closedAt: new Date().toISOString(),
        });
    } catch (error) {
        return fail(error instanceof Error ? error : new Error(String(error)));
    }

    if (!closed) {
        return fail(`Ticket #${ticket.ticketNumber} changed state before it could be closed.`);
    }

    await announce('closed', closed, change);
    return ok(closed);
}

export async function reopenTicket(ticketId: number, change: TicketChange): Promise<Result<TicketEntity>> {
    const ticket = await ticketsRepo.getById(ticketId);
    if (!ticket) return fail(`No ticket found with id ${ticketId}`);

    if (ticket.status !== 'closed') {
        return fail(`Ticket #${ticket.ticketNumber} is ${ticket.status} and cannot be reopened.`);
    }

    let reopened: TicketEntity | null;
    try {
        reopened = await ticketsRepo.transitionStatus(ticketId, 'closed', { status: 'open', closedAt: null });
    } catch (error) {
        return fail(error instanceof Error ? error : new Error(String(error)));
    }

    if (!reopened) {
        return fail(`Ticket #${ticket.ticketNumber} changed state before it could be reopened.`);
    }

    await announce('reopened', reopened, change);
    return ok(reopened);
}

/**
 * Marks a ticket deleted without removing the row.
 *
 * A delete *trigger* cannot fire on a row that no longer exists, and the record
 * has to survive to answer "did this member ever have a verification ticket?"
 * after its channel is long gone. `channelId` is cleared because the channel
 * genuinely stops existing; the rest of the record stays.
 *
 * Announced as `deleted` with no channel, because the row no longer names one. A
 * channel deleted by hand is not this: it only clears `channelId`, through
 * {@link forgetTicketChannel}, and announces nothing.
 */
export async function deleteTicket(ticketId: number, change: TicketChange): Promise<Result<TicketEntity>> {
    const ticket = await ticketsRepo.getById(ticketId);
    if (!ticket) return fail(`No ticket found with id ${ticketId}`);

    if (ticket.status === 'deleted') {
        return fail(`Ticket #${ticket.ticketNumber} is already deleted.`);
    }

    let deleted: TicketEntity | null;
    try {
        // Guarded on the status just read rather than on a single expected one,
        // because deleting is legal from both `open` and `closed`.
        deleted = await ticketsRepo.transitionStatus(ticketId, ticket.status, {
            status: 'deleted',
            deletedAt: new Date().toISOString(),
            channelId: null,
        });
    } catch (error) {
        return fail(error instanceof Error ? error : new Error(String(error)));
    }

    if (!deleted) {
        return fail(`Ticket #${ticket.ticketNumber} changed state before it could be deleted.`);
    }

    await announce('deleted', deleted, change);
    return ok(deleted);
}

/**
 * Answers "does this member have an open ticket of type X, and which?" with one
 * indexed query and no Discord call. Null when they have none; their newest
 * when they have several.
 *
 * The question this whole table exists for. The old answer was: list channels,
 * filter by a name regex, fetch pinned messages, decode a base64 blob — several
 * rate-limited calls, per member, with an unpredictable cost because the state
 * message lookup had a three-tier fallback.
 */
export async function findOpenTicket(
    guildId: string,
    subjectId: string,
    type?: TicketType
): Promise<Pick<TicketEntity, 'id' | 'channelId'> | null> {
    return ticketsRepo.newestOpenBySubject(guildId, subjectId, type);
}

export async function getTicketByChannel(channelId: string): Promise<TicketEntity | null> {
    return ticketsRepo.getByChannelId(channelId);
}

export async function getTicket(ticketId: number): Promise<TicketEntity | null> {
    return ticketsRepo.getById(ticketId);
}
