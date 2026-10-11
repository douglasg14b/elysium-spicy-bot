/**
 * How the clock-shaped controls read and write their values — a time of day stored as
 * 24-hour `HH:MM` and shown on a 12-hour clock, and days of the week stored as `'mon'` …
 * `'sun'`. Shared by the controls and the card summary, so both read a value the same
 * way.
 *
 * Nothing here knows what the values are for. The server's conformance check holds any
 * schema behind these controls to exactly these shapes.
 */

import type { BlockDayKey } from '@brattybot/web-sdk';
import { BLOCK_DAY_KEYS } from './contractValues';

/** Each stored day key's short label. */
const DAY_LABELS: Record<BlockDayKey, string> = {
    mon: 'Mon',
    tue: 'Tue',
    wed: 'Wed',
    thu: 'Thu',
    fri: 'Fri',
    sat: 'Sat',
    sun: 'Sun',
};

/**
 * The days of the week as the control offers them: {@link BLOCK_DAY_KEYS}' order, Monday
 * first, so Mon–Fri sits together. The keys are the server's own, read off the generated
 * enum (`contractValues.ts`).
 */
export const DAYS_OF_WEEK: readonly { readonly value: BlockDayKey; readonly label: string }[] = BLOCK_DAY_KEYS.map(
    (day) => ({ value: day, label: DAY_LABELS[day] })
);

/** Morning or afternoon, on a 12-hour clock. */
export type ClockPeriod = 'AM' | 'PM';

/** A time of day as a 12-hour clock shows it. */
export interface TwelveHourTime {
    /** 1–12. */
    readonly hour: number;
    /** 0–59. */
    readonly minute: number;
    readonly period: ClockPeriod;
}

const TIME_OF_DAY_SHAPE = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** A stored `HH:MM` as 12-hour parts, or undefined for anything that is not one. */
export function toTwelveHour(value: unknown): TwelveHourTime | undefined {
    if (typeof value !== 'string') return undefined;
    const match = TIME_OF_DAY_SHAPE.exec(value);
    if (!match) return undefined;

    const hours = Number(match[1]);
    // Midnight is 12 AM and noon is 12 PM — never 0.
    return { hour: hours % 12 === 0 ? 12 : hours % 12, minute: Number(match[2]), period: hours < 12 ? 'AM' : 'PM' };
}

/** 12-hour parts as the stored 24-hour `HH:MM`. */
export function fromTwelveHour({ hour, minute, period }: TwelveHourTime): string {
    const hours = (hour % 12) + (period === 'PM' ? 12 : 0);
    return `${String(hours).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

/** A stored `HH:MM` as a 12-hour clock reads it — `9:00 AM` — or `''` when it is not one. */
export function formatTimeOfDay(value: unknown): string {
    const time = toTwelveHour(value);
    return time ? `${time.hour}:${String(time.minute).padStart(2, '0')} ${time.period}` : '';
}

/**
 * Stored day keys as a card reads them: `Mon, Wed, Fri` in week order whatever order they
 * were picked in, `Every day` when all seven are, and `''` when none (or nothing readable)
 * is.
 */
export function formatDaysOfWeek(value: unknown): string {
    if (!Array.isArray(value)) return '';
    const picked = DAYS_OF_WEEK.filter((day) => value.includes(day.value));
    if (picked.length === DAYS_OF_WEEK.length) return 'Every day';
    return picked.map((day) => day.label).join(', ');
}
