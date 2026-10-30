/**
 * The calendar the warning form's defaults are drawn on.
 *
 * A warning's days are **Pacific calendar days** (`src/features/warnings/logic/warningDates.ts`):
 * "today" is today in Los Angeles whatever the browser's zone, and the default drop-off is six
 * calendar months after the issued day, clamped to the end of a shorter month. The form
 * mirrors that to fill in its defaults, and sends what it filled in — so a mirror that drifted
 * (a different default length, say) would issue warnings the server accepts with the wrong
 * dates. `src/features/warnings/logic/__tests__/warningBrowserMirrorDrift.test.ts` holds this
 * file to the server's constants and functions.
 *
 * Dates travel as `YYYY-MM-DD` and are never turned into instants here, so nothing re-zones
 * them into the day before.
 */

/** The warning model's time zone, as the server's `WARNING_TIMEZONE`. */
export const WARNING_TIME_ZONE = 'America/Los_Angeles';

/** How long a warning counts by default, as the server's `WARNING_DEFAULT_DURATION_MONTHS`. */
export const WARNING_DEFAULT_DURATION_MONTHS = 6;

const CALENDAR_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Today on the Pacific calendar, as `YYYY-MM-DD`. */
export function pacificToday(now: Date = new Date()): string {
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: WARNING_TIME_ZONE,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).formatToParts(now);
    const part = (type: Intl.DateTimeFormatPartTypes): string => {
        const found = parts.find((candidate) => candidate.type === type)?.value;
        if (!found) throw new Error(`No ${type} in the Pacific date for ${now.toISOString()}.`);
        return found;
    };
    return `${part('year')}-${part('month')}-${part('day')}`;
}

/**
 * `date` moved by whole calendar months, the day clamped to the target month's length
 * (31 Aug + 6 months is 28 or 29 Feb). Null for anything that is not a real `YYYY-MM-DD`.
 */
export function addCalendarMonths(date: string, months: number): string | null {
    const match = CALENDAR_DATE.exec(date);
    if (!match) return null;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return null;

    const monthIndex = month - 1 + months;
    const targetYear = year + Math.floor(monthIndex / 12);
    const targetMonth = (((monthIndex % 12) + 12) % 12) + 1;
    const targetDay = Math.min(day, daysInMonth(targetYear, targetMonth));
    return `${String(targetYear).padStart(4, '0')}-${pad(targetMonth)}-${pad(targetDay)}`;
}

/** The drop-off a warning issued on `issuedOn` gets when nobody picks one. Null for a date that is not one. */
export function defaultDropsOff(issuedOn: string): string | null {
    return addCalendarMonths(issuedOn.trim(), WARNING_DEFAULT_DURATION_MONTHS);
}

function daysInMonth(year: number, month: number): number {
    return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function pad(value: number): string {
    return String(value).padStart(2, '0');
}
