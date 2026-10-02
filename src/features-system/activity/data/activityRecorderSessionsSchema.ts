import type { ColumnType, Generated } from 'kysely';

/**
 * One row per process that recorded activity, so the next one can tell what it missed.
 *
 * The gap before a session runs from its predecessor's `lastSeenAt` to its own
 * `startedAt`. `id` orders sessions, and is `serial` (int4) on postgres for the same
 * reason as `activity_events.id`: `pg` returns it as a number.
 */
export interface ActivityRecorderSessionsTable {
    id: Generated<number>;
    /** When this process began recording, at `ClientReady`. */
    startedAt: ColumnType<Date, string, string>;
    /** Refreshed by a heartbeat while the process is alive. */
    lastSeenAt: ColumnType<Date, string, string>;
    /**
     * When the gap *before* this session was backfilled; null until then. Set on insert
     * for the very first session, which has no predecessor to measure a gap from.
     */
    gapFilledAt: ColumnType<Date | null, string | null, string | null>;
}
