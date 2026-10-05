import { SCHEDULE_INTERVAL_MINUTES, type ResolvedSchedule, type ScheduleDay } from '../blocks/triggerSchedule';

/*
 * When a Schedule trigger next fires, in a server's time zone.
 *
 * Pure, and built on `Intl` alone — the repo carries no date library. Every rule about
 * clocks changing lives here, in one place, and the tests drive it across real
 * transitions (`__tests__/scheduleTimes.test.ts`).
 *
 * Two different readings of "the same time", on purpose:
 *
 *  - **A daily or weekday time fires once per local day.** Each eligible local date's
 *    `HH:MM` resolves to exactly one instant: a time the clocks skip moves forward by the
 *    gap (2:30 AM on a spring-forward night fires at 3:30 AM), and a time the clocks
 *    repeat takes the first (1:30 AM daylight time). Never "the next instant whose wall
 *    clock reads 01:30" — that fires twice on fall-back, because the first fire advances
 *    from a moment between the two 01:30s.
 *  - **"Every so often" fires whenever the wall clock reads a time where
 *    `(hour × 60 + minute) % N === 0`.** So hourly runs twice through a repeated hour and
 *    not at all through a skipped one. A wall-clock match rather than "midnight + k·N",
 *    which matters in a zone whose clock change skips midnight itself (America/Santiago).
 */

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

/** One instant's wall clock in a zone. */
interface WallClock {
    readonly year: number;
    readonly month: number;
    readonly day: number;
    readonly hour: number;
    readonly minute: number;
    readonly weekday: ScheduleDay;
}

/** `en-US` `weekday: 'short'` → the schedule's day keys. A fixed locale, so this never varies. */
const WEEKDAYS: Readonly<Partial<Record<string, ScheduleDay>>> = {
    Mon: 'mon',
    Tue: 'tue',
    Wed: 'wed',
    Thu: 'thu',
    Fri: 'fri',
    Sat: 'sat',
    Sun: 'sun',
};

const formatters = new Map<string, Intl.DateTimeFormat>();

/**
 * The cached formatter for a zone.
 *
 * `hourCycle: 'h23'`, never `hour12: false`: some runtimes print midnight as `24` under
 * the latter. Cached only once constructed, so a zone `Intl` rejects throws its
 * `RangeError` on every call rather than once.
 */
function formatterFor(timeZone: string): Intl.DateTimeFormat {
    let formatter = formatters.get(timeZone);
    if (!formatter) {
        formatter = new Intl.DateTimeFormat('en-US', {
            timeZone,
            hourCycle: 'h23',
            year: 'numeric',
            month: 'numeric',
            day: 'numeric',
            hour: 'numeric',
            minute: 'numeric',
            weekday: 'short',
        });
        formatters.set(timeZone, formatter);
    }
    return formatter;
}

/**
 * Throw a `RangeError` when `Intl` rejects `timeZone` — for a caller that must know before
 * working out any one time (reconcile, which nulls a whole guild's schedules then).
 */
export function assertTimeZone(timeZone: string): void {
    formatterFor(timeZone);
}

/** What the wall clock reads at `instant` in `timeZone`. */
function wallClockAt(instant: number, timeZone: string): WallClock {
    const parts = new Map(formatterFor(timeZone).formatToParts(instant).map((part) => [part.type, part.value]));
    const read = (type: Intl.DateTimeFormatPartTypes): number => Number(parts.get(type));
    const weekday = WEEKDAYS[parts.get('weekday') ?? ''];
    if (!weekday) {
        throw new Error(`Could not read the day of the week in ${timeZone} from ${JSON.stringify(parts.get('weekday'))}.`);
    }

    return { year: read('year'), month: read('month'), day: read('day'), hour: read('hour'), minute: read('minute'), weekday };
}

/** The zone's offset from UTC at `instant`, in milliseconds (positive east of Greenwich). */
function offsetAt(instant: number, timeZone: string): number {
    const wall = wallClockAt(instant, timeZone);
    return Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute) - floorToMinute(instant);
}

function floorToMinute(instant: number): number {
    return Math.floor(instant / MINUTE_MS) * MINUTE_MS;
}

/**
 * The one instant a local date's `HH:MM` fires at.
 *
 * Tries the offsets in force a day either side — which straddle any clock change that
 * could touch this date, since no zone is more than 14 hours from UTC — and keeps the
 * candidates whose wall clock reads back as asked. A repeated time reads back twice: the
 * earlier is the first. A skipped time reads back never: the later candidate is the one
 * worked out with the offset from before the change, which lands the gap's length later
 * on the wall clock — 2:30 AM becomes 3:30 AM.
 */
function resolveLocalTime(year: number, month: number, day: number, hour: number, minute: number, timeZone: string): number {
    const asUtc = Date.UTC(year, month - 1, day, hour, minute);
    const candidates = [...new Set([offsetAt(asUtc - DAY_MS, timeZone), offsetAt(asUtc + DAY_MS, timeZone)])]
        .map((offset) => asUtc - offset)
        .sort((first, second) => first - second);

    const readsBack = candidates.filter((candidate) => {
        const wall = wallClockAt(candidate, timeZone);
        return wall.year === year && wall.month === month && wall.day === day && wall.hour === hour && wall.minute === minute;
    });

    return readsBack[0] ?? candidates[candidates.length - 1];
}

/** `HH:MM` as hours and minutes. The schema holds the shape; this only splits it. */
function splitTime(time: string): { readonly hour: number; readonly minute: number } {
    const [hour, minute] = time.split(':').map(Number);
    return { hour, minute };
}

/**
 * The next fire of a daily or days-of-week schedule strictly after `after`: walk local
 * dates from the one `after` falls on, resolve each eligible date's time, and take the
 * first that lands after it. Eight dates always reach one, since at least one day of the
 * week is picked.
 */
function nextDailyTime(
    time: string,
    days: readonly ScheduleDay[] | undefined,
    timeZone: string,
    after: number
): number {
    const { hour, minute } = splitTime(time);
    const today = wallClockAt(after, timeZone);

    for (let offsetDays = 0; offsetDays <= 8; offsetDays += 1) {
        // Date.UTC normalises an overflowing day, so this walks month and year ends too.
        const date = new Date(Date.UTC(today.year, today.month - 1, today.day + offsetDays));
        const candidate = resolveLocalTime(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), hour, minute, timeZone);
        if (candidate <= after) {
            continue;
        }
        if (days && !days.includes(wallClockAt(candidate, timeZone).weekday)) {
            continue;
        }
        return candidate;
    }

    throw new Error(`No ${time} on ${days?.join(', ') ?? 'any day'} in ${timeZone} within eight days — no day was picked.`);
}

/**
 * The next whole minute strictly after `after` whose wall clock is a multiple of
 * `everyMinutes` past local midnight.
 *
 * Jumps straight to the next multiple rather than walking minute by minute. A jump that
 * crosses a clock change is pulled back to the change itself — otherwise a gap could carry
 * it past a multiple that exists on the far side (every 2 hours, 1:30 AM, clocks going 3 →
 * 4 AM: a straight 150-minute jump reads 5 AM and misses 4 AM).
 */
function nextIntervalTime(everyMinutes: number, timeZone: string, after: number): number {
    let instant = floorToMinute(after) + MINUTE_MS;

    // Bounded: each pass either returns or moves forward to a multiple or a clock change.
    for (let pass = 0; pass < 64; pass += 1) {
        const wall = wallClockAt(instant, timeZone);
        const past = (wall.hour * 60 + wall.minute) % everyMinutes;
        if (past === 0) {
            return instant;
        }

        const landing = instant + (everyMinutes - past) * MINUTE_MS;
        const offsetBefore = offsetAt(instant, timeZone);
        instant = offsetAt(landing, timeZone) === offsetBefore ? landing : firstMinuteOfOffsetChange(instant, landing, offsetBefore, timeZone);
    }

    throw new Error(`Could not find the next ${everyMinutes}-minute mark in ${timeZone} after ${new Date(after).toISOString()}.`);
}

/** The first whole minute in `(from, to]` whose offset is no longer `offsetBefore`. */
function firstMinuteOfOffsetChange(from: number, to: number, offsetBefore: number, timeZone: string): number {
    let low = from;
    let high = to;
    while (high - low > MINUTE_MS) {
        const middle = floorToMinute(low + (high - low) / 2);
        if (offsetAt(middle, timeZone) === offsetBefore) {
            low = middle;
        } else {
            high = middle;
        }
    }
    return high;
}

/**
 * When a schedule next fires, strictly after `after`, in `timeZone` (an IANA name).
 *
 * `schedule` comes from the block's parsed config through `resolveSchedule`, so its `days`
 * are already unique and Monday first, and each arm holds exactly what its `repeat` uses.
 *
 * @throws RangeError for a zone `Intl` rejects. The caller logs it; nothing falls back to
 * another zone.
 */
export function nextScheduleTime(schedule: ResolvedSchedule, timeZone: string, after: Date): Date {
    const from = after.getTime();
    switch (schedule.repeat) {
        case 'daily':
            return new Date(nextDailyTime(schedule.time, undefined, timeZone, from));
        case 'days':
            return new Date(nextDailyTime(schedule.time, schedule.days, timeZone, from));
        case 'interval':
            return new Date(nextIntervalTime(SCHEDULE_INTERVAL_MINUTES[schedule.every], timeZone, from));
        default: {
            const illegal: never = schedule;
            throw new Error(`Unknown schedule ${JSON.stringify(illegal)}.`);
        }
    }
}
