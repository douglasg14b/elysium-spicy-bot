import { describe, expect, it } from 'vitest';
import {
    formatLocalDateKey,
    getDbMatchPairsForToday,
    isBirthdayCelebratedToday,
    isLeapYear,
    wasAnnouncedOnSameLocalDayAsNow,
} from '../birthdayCelebration';

describe('isLeapYear', () => {
    it('detects leap and non-leap years', () => {
        expect(isLeapYear(2024)).toBe(true);
        expect(isLeapYear(2025)).toBe(false);
        expect(isLeapYear(2000)).toBe(true);
        expect(isLeapYear(1900)).toBe(false);
    });
});

describe('isBirthdayCelebratedToday', () => {
    it('treats Feb 29 birthday on Feb 28 in a non-leap year', () => {
        const now = new Date(2025, 1, 28);
        expect(isBirthdayCelebratedToday(2, 29, now)).toBe(true);
    });

    it('does not treat Feb 29 birthday on Mar 1 in a non-leap year', () => {
        const now = new Date(2025, 2, 1);
        expect(isBirthdayCelebratedToday(2, 29, now)).toBe(false);
    });

    it('celebrates Feb 29 on Feb 29 in a leap year', () => {
        const now = new Date(2024, 1, 29);
        expect(isBirthdayCelebratedToday(2, 29, now)).toBe(true);
    });

    it('does not celebrate Feb 29 on Feb 28 in a leap year', () => {
        const now = new Date(2024, 1, 28);
        expect(isBirthdayCelebratedToday(2, 29, now)).toBe(false);
    });

    it('matches plain birthdays on the same local calendar day', () => {
        const now = new Date(2025, 6, 15);
        expect(isBirthdayCelebratedToday(7, 15, now)).toBe(true);
        expect(isBirthdayCelebratedToday(7, 14, now)).toBe(false);
    });
});

describe('getDbMatchPairsForToday', () => {
    it('includes Feb 29 pair on Feb 28 non-leap', () => {
        const now = new Date(2025, 1, 28);
        const pairs = getDbMatchPairsForToday(now);
        expect(pairs).toContainEqual([2, 28]);
        expect(pairs).toContainEqual([2, 29]);
    });

    it('does not include Feb 29 pair on Feb 28 leap year', () => {
        const now = new Date(2024, 1, 28);
        const pairs = getDbMatchPairsForToday(now);
        expect(pairs).toEqual([[2, 28]]);
    });
});

describe('formatLocalDateKey', () => {
    it('matches dedup expectation for same local calendar day', () => {
        const morning = new Date(2025, 1, 28, 8, 0, 0);
        const evening = new Date(2025, 1, 28, 22, 0, 0);
        expect(formatLocalDateKey(morning)).toBe(formatLocalDateKey(evening));
    });
});

describe('wasAnnouncedOnSameLocalDayAsNow', () => {
    it('returns true when last announcement is the same local day as now', () => {
        const now = new Date(2025, 1, 28, 20, 0, 0);
        const last = new Date(2025, 1, 28, 9, 0, 0);
        expect(wasAnnouncedOnSameLocalDayAsNow(last, now)).toBe(true);
    });

    it('returns false across adjacent local days', () => {
        const now = new Date(2025, 2, 1, 0, 0, 0);
        const last = new Date(2025, 1, 28, 23, 0, 0);
        expect(wasAnnouncedOnSameLocalDayAsNow(last, now)).toBe(false);
    });
});
