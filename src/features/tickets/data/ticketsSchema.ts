import type { ColumnType, Generated, Insertable, Selectable, Updateable } from 'kysely';

/**
 * What kind of ticket this is, which decides its category, name template,
 * permission model and controls.
 *
 * A closed union rather than free text because a type is not a label: each value
 * has code behind it (a permission arrangement, a template) and an unrecognised
 * value has no behaviour to fall back on. Adding one is a deliberate edit here
 * plus a definition in `ticketTypes.ts`, which is the point — a typo cannot
 * invent a ticket type that renders but has no permission model.
 *
 * `support` is the type every ticket in the wild today would have been, and
 * `verification` is the one flows open. Support is a *type*, not a legacy path:
 * there is one ticket implementation and both go through it.
 */
export const TICKET_TYPES = ['support', 'verification'] as const;
export type TicketType = (typeof TICKET_TYPES)[number];

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

export function isTicketType(value: string): value is TicketType {
    return (TICKET_TYPES as readonly string[]).includes(value);
}

export function isTicketStatus(value: string): value is TicketStatus {
    return (TICKET_STATUSES as readonly string[]).includes(value);
}
