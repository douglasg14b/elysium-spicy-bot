import { describe, expect, it } from 'vitest';
import { ACTIVITY_STATUSES, STATS_PERIODS } from '../contractValues';
import {
    bucketLabel,
    ACTIVITY_STATUS_PRESENTATION,
    STATS_PERIOD_LABELS,
    formatBucketDate,
    formatMoment,
    formatMomentWithTime,
    formatOptionalNumber,
    formatPercent,
    formatRate,
    formatVoiceDuration,
} from '../levelingPresentation';

/**
 * The formatting both leveling pages share.
 *
 * The status map gets a completeness test as well as a compile-time one: `satisfies` on a
 * `Record` catches a *missing* key, but only a test catches a key that exists and is
 * quietly wrong about which vocabulary it came from.
 */

describe('ACTIVITY_STATUS_PRESENTATION', () => {
    it('covers every status the server can emit', () => {
        expect(Object.keys(ACTIVITY_STATUS_PRESENTATION).sort()).toEqual(
            [...ACTIVITY_STATUSES].sort()
        );
    });

    it('uses the bot’s own words so the card and the dashboard agree', () => {
        // `formatActivityStatus` in `statsCardMetrics.ts`, verbatim. A member reading
        // "Dormant" on their card and "Inactive" here would think they were different facts.
        expect(ACTIVITY_STATUS_PRESENTATION.active.label).toBe('Active');
        expect(ACTIVITY_STATUS_PRESENTATION.quiet.label).toBe('Quiet');
        expect(ACTIVITY_STATUS_PRESENTATION.dormant.label).toBe('Dormant');
        expect(ACTIVITY_STATUS_PRESENTATION.none.label).toBe('No activity');
    });

    it('gives each status a distinct colour', () => {
        // Two statuses sharing a colour makes the badge decorative rather than informative.
        const colors = Object.values(ACTIVITY_STATUS_PRESENTATION).map((entry) => entry.color);
        expect(new Set(colors).size).toBe(colors.length);
    });
});

describe('STATS_PERIOD_LABELS', () => {
    it('covers every period the picker offers', () => {
        expect(Object.keys(STATS_PERIOD_LABELS).sort()).toEqual([...STATS_PERIODS].sort());
    });
});

describe('formatMoment', () => {
    it('renders a dash for a member who has never been active', () => {
        // Null is a real answer, not a failure: a progress row with no activity has no
        // last-active timestamp.
        expect(formatMoment(null)).toBe('—');
    });

    it('renders a dash rather than "Invalid Date" for a malformed timestamp', () => {
        expect(formatMoment('not a date')).toBe('—');
        expect(formatMomentWithTime('not a date')).toBe('—');
    });

    it('renders the date for a real ISO timestamp', () => {
        /*
         * Asserting the year rather than the whole string: `toLocaleDateString` is the
         * runtime's to format and pinning it would make this a locale detector — but
         * `not.toBe('—')` alone would also pass for `'Invalid Date'`, which is the failure
         * mode actually worth excluding.
         */
        expect(formatMoment('2026-09-15T12:00:00.000Z')).toMatch(/2026/);
        expect(formatMomentWithTime('2026-09-15T12:00:00.000Z')).toMatch(/2026/);
    });
});

describe('formatBucketDate', () => {
    it('splits the day key rather than parsing it as a timestamp', () => {
        /*
         * The regression this exists for: `new Date('2026-09-15')` is UTC midnight, so any
         * browser west of Greenwich would label every bar the day before. The key is a day
         * string and is read as one.
         */
        expect(formatBucketDate('2026-09-15')).toBe('9/15');
        expect(formatBucketDate('2026-01-02')).toBe('1/2');
    });

    it('passes an unexpected key through instead of mangling it', () => {
        // Weekly buckets are still day keys today, but a server that starts sending
        // something else should show it, not a fabricated date.
        expect(formatBucketDate('2026-W38')).toBe('2026-W38');
    });

    it('names the span a weekly bucket covers, not just its first day', () => {
        /*
         * The server sets a weekly bucket's `activityDate` to `weekDays[0].activityDate` — the
         * week's first day. A bare `9/15` on a year chart therefore reads as one day holding
         * seven days of events, which overstates it by a factor of seven on the one figure an
         * operator would repeat out loud.
         */
        expect(bucketLabel('2026-09-15', 'weekly')).toBe('week of 9/15');
    });

    it('leaves a daily bucket unprefixed', () => {
        // A day needs no qualifier, and "week of" on every bar of a 7-day chart would be noise.
        expect(bucketLabel('2026-09-15', 'daily')).toBe('9/15');
    });
});

describe('number formatting', () => {
    it('renders a rate to one decimal, leaving the unit to the label', () => {
        // No unit suffix: each row is labelled "Messages / day" already, and the parameter
        // that used to carry one was passed `''` by every caller.
        expect(formatRate(3.44)).toBe('3.4');
        expect(formatRate(3.45)).toBe('3.5');
        expect(formatRate(0)).toBe('0.0');
    });

    it('renders a share percentage without a fake decimal', () => {
        // Every share metric is `Math.round(… * 100)` server-side, so `12.0%` would
        // advertise a precision the figure does not have. `67.6` rounds rather than
        // truncating, which is the half of this that a `Math.trunc` implementation would fail.
        expect(formatPercent(12)).toBe('12%');
        expect(formatPercent(67.6)).toBe('68%');
    });

    it('distinguishes "no denominator" from zero', () => {
        // `avgMessageLengthRecent` is null when there were no recent messages to average.
        // `0.0` would claim the member sent empty messages rather than none.
        expect(formatOptionalNumber(null)).toBe('—');
        expect(formatOptionalNumber(0)).toBe('0.0');
        // Deliberately not a `.x5` value: `42.55` is not exactly representable in binary
        // floating point and `toFixed` rounds it *down*, so pinning that would be a test
        // about IEEE-754 rather than about this function.
        expect(formatOptionalNumber(42.62)).toBe('42.6');
    });
});

describe('formatVoiceDuration', () => {
    it('renders hours and minutes together', () => {
        expect(formatVoiceDuration(4 * 3600 + 12 * 60)).toBe('4h 12m');
    });

    it('drops the hours when there are none', () => {
        expect(formatVoiceDuration(12 * 60)).toBe('12m');
    });

    it('keeps a sub-minute session visible rather than rounding it to 0m', () => {
        expect(formatVoiceDuration(42)).toBe('42s');
    });

    it('renders a dash when nobody has held a channel open', () => {
        expect(formatVoiceDuration(0)).toBe('—');
    });
});
