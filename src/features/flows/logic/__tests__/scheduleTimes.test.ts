import { describe, expect, it } from 'vitest';
import type { ResolvedSchedule, ScheduleDay, ScheduleInterval } from '../../blocks/triggerSchedule';
import { nextScheduleTime } from '../scheduleTimes';

const LOS_ANGELES = 'America/Los_Angeles';

const daily = (time: string): ResolvedSchedule => ({ repeat: 'daily', time });
const onDays = (time: string, days: readonly ScheduleDay[]): ResolvedSchedule => ({ repeat: 'days', time, days });
const every = (interval: ScheduleInterval): ResolvedSchedule => ({ repeat: 'interval', every: interval });

/** The next fire as an ISO string, so a failure prints both instants readably. */
function next(config: ResolvedSchedule, timeZone: string, after: string): string {
    return nextScheduleTime(config, timeZone, new Date(after)).toISOString();
}

describe('nextScheduleTime — every day and on chosen days', () => {
    it.each([
        { name: 'before 09:00 fires the same day', after: '2026-07-01T15:00:00.000Z', want: '2026-07-01T16:00:00.000Z' },
        { name: 'after 09:00 fires the next day', after: '2026-07-01T17:00:00.000Z', want: '2026-07-02T16:00:00.000Z' },
        { name: 'exactly at a fire time gives the next one', after: '2026-07-01T16:00:00.000Z', want: '2026-07-02T16:00:00.000Z' },
        { name: 'a breath before a fire time gives that one', after: '2026-07-01T15:59:59.999Z', want: '2026-07-01T16:00:00.000Z' },
    ])('Los Angeles daily 09:00: $name', ({ after, want }) => {
        expect(next(daily('09:00'), LOS_ANGELES, after)).toBe(want);
    });

    it.each([
        // 2026-07-03 is a Friday.
        { name: 'Friday after the time wraps to Monday', after: '2026-07-03T17:00:00.000Z', want: '2026-07-06T16:00:00.000Z' },
        { name: 'Saturday wraps to Monday', after: '2026-07-04T12:00:00.000Z', want: '2026-07-06T16:00:00.000Z' },
        { name: 'Monday after the time goes to Wednesday', after: '2026-07-06T16:00:00.000Z', want: '2026-07-08T16:00:00.000Z' },
    ])('Mon/Wed/Fri at 09:00: $name', ({ after, want }) => {
        expect(next(onDays('09:00', ['mon', 'wed', 'fri']), LOS_ANGELES, after)).toBe(want);
    });

    it('reads the day of the week in the server zone, not UTC', () => {
        // 23:30 on Sunday in Los Angeles is already Monday in UTC; a Sunday-only schedule at
        // 23:30 fires then, and a Monday-only one waits for Monday night.
        expect(next(onDays('23:30', ['sun']), LOS_ANGELES, '2026-07-05T12:00:00.000Z')).toBe('2026-07-06T06:30:00.000Z');
        expect(next(onDays('23:30', ['mon']), LOS_ANGELES, '2026-07-05T12:00:00.000Z')).toBe('2026-07-07T06:30:00.000Z');
    });

    describe('spring-forward (2026-03-08, 2:00 AM becomes 3:00 AM)', () => {
        it('runs a skipped 02:30 at 03:30 daylight time', () => {
            expect(next(daily('02:30'), LOS_ANGELES, '2026-03-08T08:00:00.000Z')).toBe('2026-03-08T10:30:00.000Z');
        });

        it('from 03:15 daylight time, still runs at 03:30 the same day', () => {
            expect(next(daily('02:30'), LOS_ANGELES, '2026-03-08T10:15:00.000Z')).toBe('2026-03-08T10:30:00.000Z');
        });

        it('from exactly 03:30, runs the next day at 02:30', () => {
            expect(next(daily('02:30'), LOS_ANGELES, '2026-03-08T10:30:00.000Z')).toBe('2026-03-09T09:30:00.000Z');
        });
    });

    describe('fall-back (2026-11-01, 2:00 AM daylight becomes 1:00 AM standard)', () => {
        it('runs a repeated 01:30 once, at the first — daylight time', () => {
            expect(next(daily('01:30'), LOS_ANGELES, '2026-10-31T19:00:00.000Z')).toBe('2026-11-01T08:30:00.000Z');
            expect(next(daily('01:30'), LOS_ANGELES, '2026-11-01T08:30:00.000Z')).toBe('2026-11-02T09:30:00.000Z');
        });

        it('from 01:45 daylight time, runs tomorrow at 01:30 — not at 01:30 standard time today', () => {
            expect(next(daily('01:30'), LOS_ANGELES, '2026-11-01T08:45:00.000Z')).toBe('2026-11-02T09:30:00.000Z');
        });
    });
});

describe('nextScheduleTime — every so often', () => {
    it('hourly through fall-back runs at 01:00 daylight and again at 01:00 standard', () => {
        expect(next(every('1h'), LOS_ANGELES, '2026-11-01T07:30:00.000Z')).toBe('2026-11-01T08:00:00.000Z');
        expect(next(every('1h'), LOS_ANGELES, '2026-11-01T08:00:00.000Z')).toBe('2026-11-01T09:00:00.000Z');
        expect(next(every('1h'), LOS_ANGELES, '2026-11-01T09:00:00.000Z')).toBe('2026-11-01T10:00:00.000Z');
    });

    it('hourly through spring-forward goes 01:00 → 03:00', () => {
        expect(next(every('1h'), LOS_ANGELES, '2026-03-08T09:00:00.000Z')).toBe('2026-03-08T10:00:00.000Z');
    });

    it('every 6 hours lines up with local midnight', () => {
        expect(next(every('6h'), LOS_ANGELES, '2026-07-01T06:59:00.000Z')).toBe('2026-07-01T07:00:00.000Z');
        expect(next(every('6h'), LOS_ANGELES, '2026-07-01T07:00:00.000Z')).toBe('2026-07-01T13:00:00.000Z');
    });

    it('every 30 minutes fires at :00 and :30', () => {
        expect(next(every('30m'), LOS_ANGELES, '2026-07-01T16:05:00.000Z')).toBe('2026-07-01T16:30:00.000Z');
        expect(next(every('30m'), LOS_ANGELES, '2026-07-01T16:30:00.000Z')).toBe('2026-07-01T17:00:00.000Z');
    });

    it('every 20 minutes in Asia/Kolkata (+05:30) lines up with local :00, :20 and :40', () => {
        // 09:05 IST → 09:20 IST, which is 03:50 UTC — not a UTC :20.
        expect(next(every('20m'), 'Asia/Kolkata', '2026-07-01T03:35:00.000Z')).toBe('2026-07-01T03:50:00.000Z');
        expect(next(every('20m'), 'Asia/Kolkata', '2026-07-01T03:50:00.000Z')).toBe('2026-07-01T04:10:00.000Z');
    });

    it("follows the wall clock across America/Santiago's change, which skips midnight", () => {
        // 2026-09-06: at 00:00 (-04) the clocks go to 01:00 (-03). From 18:00 on the 5th,
        // every 6 hours skips the midnight that never happens and fires at 06:00.
        expect(next(every('6h'), 'America/Santiago', '2026-09-05T22:00:00.000Z')).toBe('2026-09-06T09:00:00.000Z');
        // Hourly: 23:00 (-04), then 01:00 (-03) straight after it.
        expect(next(every('1h'), 'America/Santiago', '2026-09-06T02:30:00.000Z')).toBe('2026-09-06T03:00:00.000Z');
        expect(next(every('1h'), 'America/Santiago', '2026-09-06T03:00:00.000Z')).toBe('2026-09-06T04:00:00.000Z');
    });

    it('does not jump past a mark on the far side of a gap', () => {
        // Europe/Helsinki 2026-03-29: 03:00 (+02) becomes 04:00 (+03). Every 2 hours from
        // 02:00 must fire at 04:00, which a straight two-hour jump would read as 05:00.
        expect(next(every('2h'), 'Europe/Helsinki', '2026-03-29T00:00:00.000Z')).toBe('2026-03-29T01:00:00.000Z');
    });
});

describe('nextScheduleTime — zones', () => {
    it('works in UTC', () => {
        expect(next(daily('09:00'), 'UTC', '2026-07-01T09:00:00.000Z')).toBe('2026-07-02T09:00:00.000Z');
        expect(next(every('4h'), 'UTC', '2026-07-01T09:00:00.000Z')).toBe('2026-07-01T12:00:00.000Z');
    });

    it('throws a RangeError for a zone Intl rejects, every time', () => {
        expect(() => next(daily('09:00'), 'Mars/Olympus_Mons', '2026-07-01T09:00:00.000Z')).toThrow(RangeError);
        expect(() => next(daily('09:00'), 'Mars/Olympus_Mons', '2026-07-01T09:00:00.000Z')).toThrow(RangeError);
    });
});
