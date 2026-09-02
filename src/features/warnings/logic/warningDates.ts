import { WARNING_DEFAULT_DURATION_MONTHS, WARNING_TIMEZONE } from '../constants';

export type CalendarDate = {
    year: number;
    month: number;
    day: number;
};

export type WarningDateErrorKind =
    | 'invalid-issued'
    | 'invalid-expires'
    | 'issued-in-future'
    | 'expires-not-after-issued'
    | 'expires-already-passed';

export type ResolveWarningDatesInput = {
    issuedInput: string;
    expiresInput: string;
    now?: Date;
};

export type ResolveWarningDatesResult =
    | { ok: true; issued: CalendarDate; expires: CalendarDate }
    | { ok: false; kind: WarningDateErrorKind };

const DATE_INPUT_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

export function getPacificCalendarDate(now: Date = new Date(), timeZone: string = WARNING_TIMEZONE): CalendarDate {
    const formatter = new Intl.DateTimeFormat('en-CA', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    });
    const dateParts = formatter.formatToParts(now);
    const yearPart = dateParts.find((part) => part.type === 'year');
    const monthPart = dateParts.find((part) => part.type === 'month');
    const dayPart = dateParts.find((part) => part.type === 'day');

    if (!yearPart || !monthPart || !dayPart) {
        throw new Error(`Failed to compute calendar date for timezone "${timeZone}"`);
    }

    return {
        year: Number(yearPart.value),
        month: Number(monthPart.value),
        day: Number(dayPart.value),
    };
}

export function formatCalendarDate(date: CalendarDate): string {
    const month = String(date.month).padStart(2, '0');
    const day = String(date.day).padStart(2, '0');
    return `${date.year}-${month}-${day}`;
}

export function calendarDateToUtcMidnightIso(date: CalendarDate): string {
    return `${formatCalendarDate(date)}T00:00:00.000Z`;
}

export function calendarDateFromUtcMidnight(date: Date): CalendarDate {
    return {
        year: date.getUTCFullYear(),
        month: date.getUTCMonth() + 1,
        day: date.getUTCDate(),
    };
}

export function compareCalendarDates(left: CalendarDate, right: CalendarDate): number {
    if (left.year !== right.year) {
        return left.year - right.year;
    }

    if (left.month !== right.month) {
        return left.month - right.month;
    }

    return left.day - right.day;
}

export function getDaysInMonth(year: number, month: number): number {
    return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function addCalendarMonths(date: CalendarDate, months: number): CalendarDate {
    const monthIndex = date.month - 1 + months;
    const year = date.year + Math.floor(monthIndex / 12);
    const month = ((monthIndex % 12) + 12) % 12;
    const daysInMonth = getDaysInMonth(year, month + 1);
    const day = Math.min(date.day, daysInMonth);

    return {
        year,
        month: month + 1,
        day,
    };
}

export function parseWarningDateInput(raw: string): CalendarDate | null | 'invalid' {
    const trimmed = raw.trim();
    if (!trimmed) {
        return null;
    }

    const match = DATE_INPUT_PATTERN.exec(trimmed);
    if (!match) {
        return 'invalid';
    }

    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);

    if (month < 1 || month > 12) {
        return 'invalid';
    }

    if (day < 1 || day > getDaysInMonth(year, month)) {
        return 'invalid';
    }

    return { year, month, day };
}

export function resolveWarningDates(input: ResolveWarningDatesInput): ResolveWarningDatesResult {
    const now = input.now ?? new Date();
    const today = getPacificCalendarDate(now);

    const parsedIssued = parseWarningDateInput(input.issuedInput);
    if (parsedIssued === 'invalid') {
        return { ok: false, kind: 'invalid-issued' };
    }

    const issued = parsedIssued ?? today;
    if (compareCalendarDates(issued, today) > 0) {
        return { ok: false, kind: 'issued-in-future' };
    }

    const parsedExpires = parseWarningDateInput(input.expiresInput);
    if (parsedExpires === 'invalid') {
        return { ok: false, kind: 'invalid-expires' };
    }

    const expires = parsedExpires ?? addCalendarMonths(issued, WARNING_DEFAULT_DURATION_MONTHS);
    if (compareCalendarDates(expires, issued) <= 0) {
        return { ok: false, kind: 'expires-not-after-issued' };
    }

    if (compareCalendarDates(expires, today) < 0) {
        return { ok: false, kind: 'expires-already-passed' };
    }

    return { ok: true, issued, expires };
}

export function isWarningActive(
    warning: { clearedAt: Date | null; expiresAt: Date },
    asOf: Date = new Date()
): boolean {
    if (warning.clearedAt) {
        return false;
    }

    const expires = calendarDateFromUtcMidnight(warning.expiresAt);
    const today = getPacificCalendarDate(asOf);
    return compareCalendarDates(expires, today) >= 0;
}

export function getActiveAsOfUtcMidnight(now: Date = new Date()): Date {
    return new Date(calendarDateToUtcMidnightIso(getPacificCalendarDate(now)));
}
