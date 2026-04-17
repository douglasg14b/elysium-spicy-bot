import { describe, expect, it } from 'vitest';
import {
    getLocalDateKey,
    getObservedMonthDayForYear,
    isBirthdayCelebratedOnDate,
} from '../birthdayCelebration';

describe('birthdayCelebration helpers', () => {
    it('observes Feb 29 birthdays on Feb 28 in non-leap years', () => {
        const observedDate = getObservedMonthDayForYear(2, 29, 2025);
        expect(observedDate).toEqual({ month: 2, day: 28 });
        expect(isBirthdayCelebratedOnDate(2, 29, new Date('2025-02-28T12:00:00'))).toBe(true);
    });

    it('observes Feb 29 birthdays on Feb 29 in leap years', () => {
        const observedDate = getObservedMonthDayForYear(2, 29, 2024);
        expect(observedDate).toEqual({ month: 2, day: 29 });
        expect(isBirthdayCelebratedOnDate(2, 29, new Date('2024-02-29T12:00:00'))).toBe(true);
    });

    it('does not treat March 1 as the celebration day for Feb 29 birthdays in non-leap years', () => {
        expect(isBirthdayCelebratedOnDate(2, 29, new Date('2025-03-01T12:00:00'))).toBe(false);
    });

    it('preserves normal birthdays', () => {
        expect(isBirthdayCelebratedOnDate(6, 15, new Date('2025-06-15T12:00:00'))).toBe(true);
        expect(isBirthdayCelebratedOnDate(6, 15, new Date('2025-06-14T12:00:00'))).toBe(false);
    });

    it('builds local date keys with stable YYYY-MM-DD shape', () => {
        expect(getLocalDateKey(new Date('2026-04-07T08:00:00'))).toBe('2026-04-07');
    });
});
