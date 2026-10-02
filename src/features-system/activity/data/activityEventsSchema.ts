import type { ColumnType, Generated } from 'kysely';

/** What a member did. Stored as plain `text`, so adding a kind needs no migration. */
export const ACTIVITY_EVENT_KINDS = ['message', 'reaction'] as const;

export type ActivityEventKind = (typeof ACTIVITY_EVENT_KINDS)[number];

/**
 * One row per recorded message or reaction: who was active, where, and when. No content.
 *
 * `id` is `serial` (int4) on postgres rather than `bigserial`, so `pg` returns it as a
 * number and the `number` type here is true on both dialects.
 */
export interface ActivityEventsTable {
    id: Generated<number>;
    guildId: string;
    userId: string;
    /** Null only for rows migrated from leveling history, which never recorded a channel. */
    channelId: string | null;
    /**
     * The channel a thread sits under, when the event landed in a thread; null
     * otherwise. It is what lets "messages in #some-channel" count a reply in a
     * thread under it, whose own `channelId` is the thread's.
     *
     * Recorded for reactions too, from the channel cache rather than a fetch — so on
     * a reaction row null can also mean a thread the bot had never seen. Harmless:
     * reactions never count toward a quiet window. Null on every row written before
     * the column existed.
     */
    parentChannelId: string | null;
    /**
     * The Discord message a `message` row records, unique across the table so the live
     * recorder and the startup backfill can both insert it and only one row lands. Null
     * for reactions, and on every row written before the column existed.
     */
    messageId: string | null;
    kind: ActivityEventKind;
    occurredAt: ColumnType<Date, string, string>;
}
