import type { ColumnType, Generated, Insertable, Selectable, Updateable } from 'kysely';

/**
 * What kind of ticket this is, which decides its name template, permission model
 * and whether opening auto-claims.
 *
 * **Was a closed union, and is deliberately no longer one.** The old
 * justification was that "each value has code behind it", which is precisely
 * what a guild-declared type invalidates: the code behind a value is now a row
 * in `ticketing_config.config`, not a branch in source. An operator adds a type
 * in the config, so the union could not be the gate without making every new
 * type a code change.
 *
 * Free text means a type key can name a definition the guild no longer declares.
 * That is handled by `getTicketTypeDefinition` returning `undefined` and the
 * surface refusing by name. Deleting a type is refused while any ticket holds it,
 * which makes this rare — but the check and the write are separate statements, so
 * a ticket opened in that window, or a row written by a process older than the
 * seed migration, reaches it without anyone hand-editing anything.
 */
export type TicketType = string;

/**
 * Where a ticket is in its life, and nothing about who owns it.
 *
 * Deliberately *not* the old `'active' | 'claimed' | 'closed'` set. That one
 * conflated two independent facts: claiming moved a ticket out of `active`, so
 * "is it claimed" and "is it still open" could not be asked separately — and
 * both are conditions a flow needs. Who holds a ticket now lives in
 * `claimerId`, and this enum is purely the lifecycle.
 *
 * `deleted` is a status rather than a row deletion. A delete *trigger* cannot
 * fire on a row that no longer exists, and the record has to survive to answer
 * "did this member ever have a verification ticket?" long after its channel is
 * gone.
 */
export const TICKET_STATUSES = ['open', 'closed', 'deleted'] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];

/**
 * A ticket, as a durable record that *has* a channel rather than a channel that
 * happens to be a ticket.
 *
 * That ordering is the whole design. Previously a ticket was its embed: state
 * lived as base64 JSON in a message field, and the only way to answer anything
 * about a ticket was to list channels, fetch pinned messages and decode a blob —
 * several rate-limited API calls per question. This table exists so a flow can
 * decide *without touching Discord at all*, so anything a condition needs is a
 * column even where Discord nominally owns it.
 *
 * `channelId` is therefore an output, not an identity, and it is nullable: a
 * ticket whose channel was deleted is still a ticket, and losing the channel
 * must not destroy the record.
 */
export interface TicketTable {
    id: Generated<number>;

    guildId: string;

    /**
     * The human-facing number, unique per guild.
     *
     * Allocated by an atomic `UPDATE ... RETURNING` before the channel is
     * created, so two moderators filing at the same moment cannot receive the
     * same number. The old path incremented in memory, created the channel, and
     * only then persisted — leaving the race open across a Discord round trip.
     */
    ticketNumber: number;

    type: TicketType;
    status: TicketStatus;

    /** Who the ticket is *about*. The hot column: "does this member have an open ticket of type X?" */
    subjectId: string;

    /**
     * Who opened it, or null when a flow did.
     *
     * Nullable because a flow-opened verification ticket has no human opener.
     * The old creation path took the opener from `interaction.user` and so could
     * not express this at all, which is one of the reasons it could not simply
     * be called by a flow.
     */
    openerId: string | null;

    /** Who currently holds it, null when unclaimed. Separate from `status` on purpose. */
    claimerId: string | null;

    /** Null once the channel is deleted. The record outlives it. */
    channelId: string | null;

    /**
     * Who these people were when the row was last written.
     *
     * Nullable because every row that predates the `2026-09-23` migration has no
     * snapshot, and because a snapshot is taken from a member the bot could
     * resolve *at that moment* — a subject who left the guild has no nickname to
     * record. Null means "not recorded", which a non-Discord surface renders as
     * the id; it does not mean "has no name".
     *
     * **Snapshots, not a cache.** The dashboard renders from these instead of
     * fetching members, which is the same argument the whole table rests on: a
     * surface that has to resolve a snowflake to display a row has not moved off
     * Discord. They are re-resolved on every write that touches the person they
     * describe, so they drift only between writes — and a ticket nobody has
     * touched in six months showing the name from six months ago is the correct
     * answer to "who was this about", not a stale one.
     *
     * `*Nickname` is the guild nickname (`member.nickname` — **not**
     * `member.displayName`, which falls back to the username and would lose the
     * distinction between "no nickname" and "nickname identical to the handle");
     * `*Username` is the global handle (`user.username`). The pair follows
     * `birthday-tracker/data/birthdaySchema.ts`, which records `displayName` and
     * `username` for the same reason — except the names are qualified here,
     * because three people appear on one row and `displayName` alone could not
     * say whose.
     *
     * **No avatar column.** Declined: an avatar is a URL that rots independently
     * of the name, on a CDN whose hash changes when the user changes their
     * picture, so a stored one is a broken image rather than an out-of-date one.
     */
    subjectUsername: string | null;
    subjectNickname: string | null;
    openerUsername: string | null;
    openerNickname: string | null;
    claimerUsername: string | null;
    claimerNickname: string | null;

    /**
     * The id of the in-channel message rendering this ticket's state.
     *
     * **Not an identity snapshot** — it is grouped into the same migration only
     * because one migration beats two, and it is called out separately so the
     * "six identity columns" framing does not absorb it silently.
     *
     * A caller with no `interaction.message` — a web route — has nothing to
     * re-render without a recorded id, so a dashboard claim would leave the
     * in-channel embed stale and lying. The alternative was re-deriving it by
     * scanning channel history, which is the three-tier fallback
     * `resolveTicketAction` records as a past mistake.
     *
     * Written from the moment the opening message is sent rather than left null
     * for a later step: a column that exists and is never written is
     * indistinguishable from one the plan forgot.
     */
    stateMessageId: string | null;

    title: string;
    reason: string;

    openedAt: ColumnType<Date, string, string>;
    /** When it was claimed, for the claimed trigger. Cleared on unclaim. */
    claimedAt: ColumnType<Date | null, string | null, string | null>;
    closedAt: ColumnType<Date | null, string | null, string | null>;
    deletedAt: ColumnType<Date | null, string | null, string | null>;
    /**
     * Optional on insert, because the column carries a database default.
     *
     * Typed to match the schema rather than to match current callers: the repo
     * always supplies it today, but a type that demanded it would be describing
     * the callers instead of the table.
     */
    updatedAt: ColumnType<Date, string | undefined, string>;
}

export type TicketEntity = Selectable<TicketTable>;
export type NewTicketEntity = Insertable<TicketTable>;
export type TicketUpdateEntity = Updateable<TicketTable>;

/**
 * A person's two names, as recorded on a ticket.
 *
 * Owned here rather than beside either of its producers because it is the shape
 * three column pairs on this table hold, and the repo, the service and the
 * resolver all have to agree about it. Two declarations of one wire shape is two
 * things to drift.
 *
 * `username` is not nullable: it is always knowable from the `User` object the
 * caller already holds, so only `nickname` depends on a member fetch. A subject
 * who has left the guild records their username with a null nickname — which an
 * all-or-nothing `TicketIdentity | null` could not express, and would have thrown
 * away a name already in hand.
 */
export interface TicketIdentity {
    readonly username: string;
    /** The guild nickname, or null when they have not set one — or are no longer a member. */
    readonly nickname: string | null;
}

export function isTicketStatus(value: string): value is TicketStatus {
    return (TICKET_STATUSES as readonly string[]).includes(value);
}
