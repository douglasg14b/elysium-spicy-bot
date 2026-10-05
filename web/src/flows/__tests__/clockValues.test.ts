import { describe, expect, it } from 'vitest';
import { DAYS_OF_WEEK, formatDaysOfWeek, formatTimeOfDay, fromTwelveHour, toTwelveHour } from '../clockValues';

describe('a time of day between 24-hour storage and the 12-hour clock', () => {
    it.each([
        { stored: '00:00', parts: { hour: 12, minute: 0, period: 'AM' }, shown: '12:00 AM' },
        { stored: '00:30', parts: { hour: 12, minute: 30, period: 'AM' }, shown: '12:30 AM' },
        { stored: '09:05', parts: { hour: 9, minute: 5, period: 'AM' }, shown: '9:05 AM' },
        { stored: '12:00', parts: { hour: 12, minute: 0, period: 'PM' }, shown: '12:00 PM' },
        { stored: '12:30', parts: { hour: 12, minute: 30, period: 'PM' }, shown: '12:30 PM' },
        { stored: '13:00', parts: { hour: 1, minute: 0, period: 'PM' }, shown: '1:00 PM' },
        { stored: '23:59', parts: { hour: 11, minute: 59, period: 'PM' }, shown: '11:59 PM' },
    ] as const)('$stored is $shown, and back', ({ stored, parts, shown }) => {
        expect(toTwelveHour(stored)).toEqual(parts);
        expect(fromTwelveHour(parts)).toBe(stored);
        expect(formatTimeOfDay(stored)).toBe(shown);
    });

    it('reads anything that is not a 24-hour HH:MM as no time', () => {
        for (const value of ['9:00', '24:00', '12:60', '', undefined, 900]) {
            expect(toTwelveHour(value)).toBeUndefined();
            expect(formatTimeOfDay(value)).toBe('');
        }
    });
});

describe('days of the week', () => {
    it('are offered Monday first', () => {
        expect(DAYS_OF_WEEK.map((day) => day.value)).toEqual(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']);
    });

    it('read in week order whatever order they were picked in', () => {
        expect(formatDaysOfWeek(['fri', 'mon', 'wed'])).toBe('Mon, Wed, Fri');
    });

    it('read as every day once all seven are picked', () => {
        expect(formatDaysOfWeek(['sun', 'sat', 'fri', 'thu', 'wed', 'tue', 'mon'])).toBe('Every day');
    });

    it('read as nothing when none is', () => {
        expect(formatDaysOfWeek([])).toBe('');
        expect(formatDaysOfWeek(undefined)).toBe('');
    });
});
