import {
    ChannelType,
    DiscordAPIError,
    RESTJSONErrorCodes,
    type Guild,
    type Message,
    type TextChannel,
} from 'discord.js';
import type { ConfiguredTicketingConfig, TicketTypeDefinition } from '../data/ticketingSchema';
import type { TicketEntity, TicketIdentity } from '../data/ticketsSchema';
import type { TicketChange } from '../ticketChanges';
import { claimTicket, closeTicket, forgetTicketChannel, reopenTicket, unclaimTicket } from '../ticketService';
import { syncTicketChannelToState } from './ticketChannelOps';
import { buildTicketButtons, buildTicketEmbed } from './ticketPresentation';
import { ticketErrorMessage } from './ticketErrorMessage';

/**
 * Commit a lifecycle transition and make Discord reflect it.
 *
 * The sequence — commit the row, move and re-permission the channel, re-render the
 * message, announce in channel — existed **five times** before this: the four button
 * handlers and `action.closeTicket`, differing only in which service call they made
 * and how they worded the sync-failure warning. The dashboard would have been the
 * sixth, and the first with no `interaction.message` to re-render, so a copy would
 * have left the in-channel embed showing a state the row no longer holds.
 *
 * `syncWarning` is per-transition because the four are genuinely different warnings,
 * and one of them is a security statement rather than an inconvenience: a close whose
 * permission write failed means **the subject can still read the channel**. A generic
 * "could not update the channel" would bury that.
 *
 * **Not a service method.** `ticketService.ts` must stay Discord-free — its own header
 * makes that one of two load-bearing rules — and this function takes a `Guild` and
 * edits a channel. It sits in `logic/` beside `ticketChannelOps.ts`, which is the layer
 * `readme.md` defines as "applies Discord effects for a decision already made".
 *
 * **Delete is deliberately not a transition here.** `ticketDeleteButton` deletes the
 * channel, so there is no channel left to sync, no message left to edit, and its
 * failure is explicitly non-retryable. Folding it in would put a branch in every step
 * of a four-step sequence to describe one caller.
 */

export type TicketTransition = 'claim' | 'unclaim' | 'close' | 'reopen';

export interface TicketTransitionOutcome {
    readonly ticket: TicketEntity;
    /** Set when the row committed but Discord did not follow. The caller must surface it. */
    readonly syncWarning: string | null;
}

export type ApplyTicketTransitionResult =
    | { ok: true; outcome: TicketTransitionOutcome }
    | { ok: false; message: string };

/**
 * Who is performing the transition.
 *
 * `mention` is separate from `id` rather than derived from it because the two callers
 * mean different things by it: a Discord handler has a `GuildMember` whose `toString()`
 * is the mention, and a web caller has a session user whose name has to be rendered as
 * text — a raw `<@id>` posted by the dashboard would ping a moderator every time
 * somebody claimed from a browser tab.
 */
export interface TicketTransitionActor {
    readonly id: string;
    readonly mention: string;
    /**
     * The actor's names, recorded when they claim.
     *
     * Only `claim` writes an identity, so only `claim` needs this — but it is asked
     * for unconditionally rather than per-transition, because a caller that has an
     * actor has their names too, and an optional member would make "claim recorded no
     * name" a silent outcome instead of a type error.
     */
    readonly identity: TicketIdentity | null;
}

export interface ApplyTicketTransitionInput {
    readonly guild: Guild;
    readonly config: ConfiguredTicketingConfig;
    readonly ticket: TicketEntity;
    readonly definition: TicketTypeDefinition;
    readonly transition: TicketTransition;
    readonly actor: TicketTransitionActor;
    /**
     * Who made the change and how deep in a chain of automated changes it sits, for
     * the announcement the service makes once the row commits.
     *
     * **Separate from {@link actor}.** `actor` is how the change is *shown* in the
     * channel — Close Ticket reads "an automated flow" there — while `change.actorId` is
     * who *did* it, announced to subscribers: the person, or the bot's own id for
     * automation. Required rather than defaulted: every caller has both facts in hand,
     * and a forgotten depth is what lets a chain of flows run on.
     */
    readonly change: TicketChange;
    /**
     * The message rendering this ticket's state, when the caller already holds it.
     *
     * A button handler does — it is the message the button is on — and passing it
     * saves a fetch. Absent, the message is resolved from `ticket.stateMessageId`,
     * which is why that column exists.
     */
    readonly message?: Message;
}

/** What each transition says in the channel, and what it warns when Discord did not follow. */
interface TransitionCopy {
    /** The in-channel announcement, given the actor's mention. */
    readonly announcement: (mention: string) => string;
    /**
     * The warning when the row committed and the channel did not move.
     *
     * Per-transition on purpose. Close's is a security statement, not an
     * inconvenience: the permission write is what removes the subject's access, so a
     * failed one leaves them reading a channel everybody believes is shut.
     */
    readonly syncWarning: string;
}

const TRANSITION_COPY: Readonly<Record<TicketTransition, TransitionCopy>> = {
    claim: {
        announcement: (mention) => `✋ **Ticket Claimed**\nThis ticket has been claimed by ${mention}.`,
        syncWarning:
            '⚠️ The ticket was claimed, but its channel could not be moved or re-permissioned. Check the category and permissions.',
    },
    unclaim: {
        announcement: (mention) =>
            `↩️ **Ticket Released**\nThis ticket has been released by ${mention} and is up for grabs.`,
        syncWarning:
            '⚠️ The ticket was released, but its channel could not be moved or re-permissioned. Check the category and permissions.',
    },
    close: {
        announcement: (mention) => `🔒 **Ticket Closed**\nThis ticket has been closed by ${mention}.`,
        syncWarning:
            '⚠️ The ticket was closed, but its channel permissions could not be updated — **the subject may still be able to read this channel.** Fix the permissions before discussing anything further here.',
    },
    reopen: {
        announcement: (mention) => `🔓 **Ticket Reopened**\nThis ticket has been reopened by ${mention}.`,
        syncWarning:
            '⚠️ The ticket was reopened, but its channel permissions could not be updated — the subject may still be locked out. Check the permissions.',
    },
};

/**
 * Commits the transition through the service, which owns every eligibility rule.
 *
 * A switch rather than a lookup table of functions, because the four take different
 * arguments and an exhaustive switch makes a fifth transition a compile error rather
 * than a missing key found at runtime.
 */
async function commit(
    input: ApplyTicketTransitionInput
): Promise<{ ok: true; ticket: TicketEntity } | { ok: false; message: string }> {
    const { ticket, transition, actor, change } = input;

    switch (transition) {
        case 'claim': {
            const result = await claimTicket(ticket.id, actor.id, actor.identity, change);
            return result.ok ? { ok: true, ticket: result.value } : { ok: false, message: ticketErrorMessage(result.error) };
        }
        case 'unclaim': {
            const result = await unclaimTicket(ticket.id, change);
            return result.ok ? { ok: true, ticket: result.value } : { ok: false, message: ticketErrorMessage(result.error) };
        }
        case 'close': {
            const result = await closeTicket(ticket.id, change);
            return result.ok ? { ok: true, ticket: result.value } : { ok: false, message: ticketErrorMessage(result.error) };
        }
        case 'reopen': {
            const result = await reopenTicket(ticket.id, change);
            return result.ok ? { ok: true, ticket: result.value } : { ok: false, message: ticketErrorMessage(result.error) };
        }
        default: {
            const unhandled: never = transition;
            throw new Error(`Unhandled ticket transition: ${String(unhandled)}`);
        }
    }
}

interface ResolvedChannel {
    /** Null when the ticket has no channel the bot can reach. */
    readonly channel: TextChannel | null;
    /** The ticket as it stands after asking, which differs only when Discord said the channel is gone. */
    readonly ticket: TicketEntity;
}

/**
 * The ticket's channel, and the ticket as it stands once Discord has been asked.
 *
 * A ticket whose channel was deleted is still a ticket — `channelId` is nullable for
 * exactly that reason — so an unreachable channel is not a failure of the transition,
 * which has already been recorded.
 *
 * `Unknown Channel` is the one answer that proves the channel is gone, deleted while the
 * bot was offline or before the gateway said so. The ticket forgets it then, so the
 * caller hands back a ticket that has stopped linking to it. Any other failure, `Missing
 * Access` included, says nothing about whether the channel exists and changes nothing.
 */
async function resolveChannel(guild: Guild, ticket: TicketEntity): Promise<ResolvedChannel> {
    if (!ticket.channelId) return { channel: null, ticket };

    try {
        const channel = await guild.channels.fetch(ticket.channelId);
        return { channel: channel?.type === ChannelType.GuildText ? channel : null, ticket };
    } catch (error) {
        if (!(error instanceof DiscordAPIError && error.code === RESTJSONErrorCodes.UnknownChannel)) {
            console.error(`[tickets] Could not fetch the channel for ticket #${ticket.ticketNumber}:`, error);
            return { channel: null, ticket };
        }

        const forgotten = await forgetTicketChannel(ticket.channelId);
        if (!forgotten.ok) {
            console.error(`[tickets] Could not record that ticket #${ticket.ticketNumber}'s channel is gone:`, forgotten.error);
            return { channel: null, ticket };
        }
        return { channel: null, ticket: forgotten.value.find((cleared) => cleared.id === ticket.id) ?? ticket };
    }
}

/**
 * Re-renders the message showing this ticket's state.
 *
 * The caller's message when it has one, otherwise the one recorded at open. Best
 * effort by design: the row is the truth and the message is one of its renderings, so
 * a message somebody deleted costs the display and nothing else. It does **not**
 * contribute to `syncWarning` — that warning is about channel placement and
 * permissions, and widening it to cover a cosmetic edit would blunt the one sentence
 * that says the subject can still read a closed channel.
 */
async function rerender(
    input: ApplyTicketTransitionInput,
    channel: TextChannel | null,
    ticket: TicketEntity
): Promise<void> {
    const rendered = {
        embeds: [buildTicketEmbed(ticket, input.definition)],
        components: buildTicketButtons(ticket),
    };

    if (input.message) {
        await input.message.edit(rendered).catch((error: unknown) => {
            console.error('[tickets] Could not re-render the ticket message:', error);
        });
        return;
    }

    if (!channel || !ticket.stateMessageId) return;

    const message = await channel.messages.fetch(ticket.stateMessageId).catch(() => null);
    if (!message) return;

    await message.edit(rendered).catch((error: unknown) => {
        console.error('[tickets] Could not re-render the ticket message:', error);
    });
}

/**
 * Applies one lifecycle transition, end to end.
 *
 * Order matters and is the same for every caller: commit, then sync the channel, then
 * re-render, then announce. Committing first is what makes the row the truth — a
 * Discord failure after this point degrades the display, never the record.
 */
export async function applyTicketTransition(
    input: ApplyTicketTransitionInput
): Promise<ApplyTicketTransitionResult> {
    const committed = await commit(input);
    if (!committed.ok) {
        // Nothing has touched Discord at this point, deliberately: a refused
        // transition must not move a channel or post an announcement for something
        // that did not happen.
        return { ok: false, message: committed.message };
    }

    const copy = TRANSITION_COPY[input.transition];
    const { channel, ticket } = await resolveChannel(input.guild, committed.ticket);

    let syncWarning: string | null = null;
    if (channel) {
        const synced = await syncTicketChannelToState(channel, input.guild, ticket, input.config);
        if (!synced.ok) {
            console.error(`[tickets] Error syncing ticket channel after ${input.transition}:`, synced.error);
            syncWarning = copy.syncWarning;
        }
    }

    await rerender(input, channel, ticket);

    if (channel) {
        await channel.send(copy.announcement(input.actor.mention)).catch((error: unknown) => {
            // The announcement is the least load-bearing step: the row is committed,
            // the channel has moved and the embed has been re-rendered, so a failure
            // here loses a courtesy line rather than any state.
            console.error('[tickets] Could not post the ticket announcement:', error);
        });
    }

    return { ok: true, outcome: { ticket, syncWarning } };
}
