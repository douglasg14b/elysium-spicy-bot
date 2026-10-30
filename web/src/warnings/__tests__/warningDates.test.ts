import { describe, expect, it } from 'vitest';
import { addCalendarMonths, defaultDropsOff, pacificToday } from '../warningDates';

describe('pacificToday', () => {
    it("is the day in Los Angeles, not the browser's or UTC's", () => {
        // 06:30 UTC on the 29th is still the 28th in Los Angeles (PDT, UTC-7).
        expect(pacificToday(new Date('2026-10-29T06:30:00Z'))).toBe('2026-10-28');
        expect(pacificToday(new Date('2026-10-29T07:30:00Z'))).toBe('2026-10-29');
    });
});

describe('addCalendarMonths', () => {
    it('moves by whole calendar months', () => {
        expect(addCalendarMonths('2026-04-15', 6)).toBe('2026-10-15');
        expect(addCalendarMonths('2026-10-29', 6)).toBe('2027-04-29');
    });

    it('clamps to the end of a shorter month, as the server does', () => {
        expect(addCalendarMonths('2026-08-31', 6)).toBe('2027-02-28');
        expect(addCalendarMonths('2027-08-31', 6)).toBe('2028-02-29');
        expect(addCalendarMonths('2026-12-31', 6)).toBe('2027-06-30');
    });

    it('is null for anything that is not a real date', () => {
        expect(addCalendarMonths('2026-02-30', 6)).toBeNull();
        expect(addCalendarMonths('2026-13-01', 6)).toBeNull();
        expect(addCalendarMonths('2026-1-01', 6)).toBeNull();
        expect(addCalendarMonths('', 6)).toBeNull();
    });
});

describe('defaultDropsOff', () => {
    it('is six months after the issued day', () => {
        expect(defaultDropsOff('2026-10-29')).toBe('2027-04-29');
        expect(defaultDropsOff(' 2026-10-29 ')).toBe('2027-04-29');
    });

    it('is null for a half-typed date', () => {
        expect(defaultDropsOff('2026-10-')).toBeNull();
    });
});
