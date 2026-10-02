import { describe, expect, it } from 'vitest';
import { ACTIVITY_BACKFILL_LOOKBACK_MS, RECORDER_HEARTBEAT_MARGIN_MS, gapBefore } from '../backfillGaps';

/** Where a gap starts and ends, from the sessions either side of it. */

const NOW = new Date('2026-10-02T12:00:00.000Z');
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function hoursAgo(hours: number): Date {
    return new Date(NOW.getTime() - hours * HOUR);
}

describe('gapBefore', () => {
    it('has nothing to fill for a session with no predecessor', () => {
        expect(gapBefore({ id: 1, startedAt: hoursAgo(1), previousLastSeenAt: null }, NOW)).toBeNull();
    });

    it("runs from the predecessor's last heartbeat, less the margin, to this session's start", () => {
        expect(gapBefore({ id: 2, startedAt: hoursAgo(1), previousLastSeenAt: hoursAgo(3) }, NOW)).toEqual({
            sessionId: 2,
            start: new Date(hoursAgo(3).getTime() - RECORDER_HEARTBEAT_MARGIN_MS),
            end: hoursAgo(1),
        });
    });

    it('clips the start to the lookback, since an older message cannot move a deadline still ahead', () => {
        const gap = gapBefore({ id: 3, startedAt: hoursAgo(1), previousLastSeenAt: hoursAgo(45 * 24) }, NOW);

        expect(gap?.start).toEqual(new Date(NOW.getTime() - ACTIVITY_BACKFILL_LOOKBACK_MS));
        expect(gap?.end).toEqual(hoursAgo(1));
    });

    it('has nothing to fill when the whole gap is older than the lookback', () => {
        const session = { id: 4, startedAt: new Date(NOW.getTime() - 31 * DAY), previousLastSeenAt: hoursAgo(40 * 24) };

        expect(gapBefore(session, NOW)).toBeNull();
    });
});
