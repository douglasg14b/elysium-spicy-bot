/**
 * The units {@link formatElapsed} reads in, largest first, with the milliseconds
 * one of each spans.
 *
 * Months and years are the calendar-free approximations (30 and 365 days). This
 * reads how long ago something was, not a date, and "11 months" for an account
 * made 340 days ago is what a person would say too.
 */
const UNITS = [
    { unit: 'year', ms: 365 * 24 * 60 * 60 * 1000 },
    { unit: 'month', ms: 30 * 24 * 60 * 60 * 1000 },
    { unit: 'day', ms: 24 * 60 * 60 * 1000 },
    { unit: 'hour', ms: 60 * 60 * 1000 },
    { unit: 'minute', ms: 60 * 1000 },
    { unit: 'second', ms: 1000 },
] as const;

/**
 * A span of time as a person would say it, in its single largest whole unit:
 * `"3 days"`, `"1 year"`, `"45 minutes"`.
 *
 * The counterpart to `formatDuration`, which gives every unit (`"3d 4h 12m 5s"`)
 * for logs and timers. This is for copy a member reads, where "3 days" says
 * everything and the hours are noise.
 *
 * Floors rather than rounds, so an account 23 hours old is "23 hours", never
 * "1 day". Negative input (a clock skewed past the timestamp) reads as zero
 * seconds rather than a negative age.
 */
export function formatElapsed(ms: number): string {
    const elapsed = Math.max(0, ms);
    const largest = UNITS.find(({ ms: unitMs }) => elapsed >= unitMs) ?? UNITS[UNITS.length - 1];
    const count = Math.floor(elapsed / largest.ms);

    return new Intl.NumberFormat('en', { style: 'unit', unit: largest.unit, unitDisplay: 'long' }).format(
        count
    );
}
