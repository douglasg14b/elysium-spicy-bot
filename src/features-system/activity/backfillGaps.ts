import type { UnfilledRecorderSession } from './data/activityRecorderSessionsRepo';

/** How often a live session refreshes its `lastSeenAt`. */
export const RECORDER_HEARTBEAT_INTERVAL_MS = 60_000;

/**
 * Taken off the previous session's last heartbeat when measuring a gap. A process can
 * die up to a full heartbeat after its last one, so the margin covers that interval
 * with room to spare; overlap is harmless, since a re-fetched message inserts nothing.
 */
export const RECORDER_HEARTBEAT_MARGIN_MS = 2 * RECORDER_HEARTBEAT_INTERVAL_MS;

/**
 * How far back a backfill reaches: 30 days.
 *
 * Equal to flows' `FLOW_MAX_DELAY_MS`, the longest a quiet window can be. A message
 * older than that cannot move a deadline that is still in the future, so fetching it
 * would be work with no effect. Declared here rather than imported because activity
 * imports no feature; a test in flows holds the two equal.
 */
export const ACTIVITY_BACKFILL_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;

/** A span of time the bot was not recording, to recover from Discord's history. */
export type ActivityGap = {
    readonly sessionId: number;
    /** Inclusive. */
    readonly start: Date;
    /** Exclusive: from here on the live recorder was listening. */
    readonly end: Date;
};

/**
 * The gap before a session, or null when there is nothing to fetch for it.
 *
 * From the previous session's last heartbeat, less the margin, to this session's start,
 * with the start clipped to {@link ACTIVITY_BACKFILL_LOOKBACK_MS} before `now`. Null when
 * there is no previous session to measure from, or when the clip leaves nothing — a
 * session that began more than the lookback ago. Either way the caller still marks the
 * gap filled: there is nothing more a later attempt could recover.
 */
export function gapBefore(session: UnfilledRecorderSession, now: Date): ActivityGap | null {
    if (!session.previousLastSeenAt) {
        return null;
    }

    const start = Math.max(
        session.previousLastSeenAt.getTime() - RECORDER_HEARTBEAT_MARGIN_MS,
        now.getTime() - ACTIVITY_BACKFILL_LOOKBACK_MS
    );
    const end = session.startedAt.getTime();
    if (start >= end) {
        return null;
    }

    return { sessionId: session.id, start: new Date(start), end: new Date(end) };
}
