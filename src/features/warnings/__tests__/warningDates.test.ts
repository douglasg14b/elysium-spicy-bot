import { describe, expect, it } from 'vitest';
import { WARNING_DEFAULT_DURATION_MONTHS } from '../constants';
import {
    addCalendarMonths,
    compareCalendarDates,
    formatCalendarDate,
    getPacificCalendarDate,
    isWarningActive,
    parseWarningDateInput,
    resolveWarningDates,
} from '../logic/warningDates';

describe('parseWarningDateInput', () => {
    it('treats blank input as a default', () => {
        expect(parseWarningDateInput('')).toBeNull();
        expect(parseWarningDateInput('   ')).toBeNull();
    });

    it('parses a valid calendar date', () => {
        expect(parseWarningDateInput('2026-09-01')).toEqual({ year: 2026, month: 9, day: 1 });
    });

    it('rejects malformed and impossible dates', () => {
        expect(parseWarningDateInput('09/01/2026')).toBe('invalid');
        expect(parseWarningDateInput('2026-13-01')).toBe('invalid');
        expect(parseWarningDateInput('2026-02-31')).toBe('invalid');
        expect(parseWarningDateInput('2026-02-29')).toBe('invalid');
    });

    it('accepts a leap day', () => {
        expect(parseWarningDateInput('2024-02-29')).toEqual({ year: 2024, month: 2, day: 29 });
    });
});

describe('getPacificCalendarDate', () => {
    it('uses the Pacific calendar day, not UTC', () => {
        expect(getPacificCalendarDate(new Date('2026-09-02T06:30:00.000Z'))).toEqual({
            year: 2026,
            month: 9,
            day: 1,
        });
        expect(getPacificCalendarDate(new Date('2026-09-02T08:00:00.000Z'))).toEqual({
            year: 2026,
            month: 9,
            day: 2,
        });
    });
});

describe('addCalendarMonths', () => {
    it('adds six months from the first of the month', () => {
        expect(addCalendarMonths({ year: 2026, month: 9, day: 1 }, WARNING_DEFAULT_DURATION_MONTHS)).toEqual({
            year: 2027,
            month: 3,
            day: 1,
        });
    });

    it('clamps overflow days', () => {
        expect(addCalendarMonths({ year: 2026, month: 8, day: 31 }, 6)).toEqual({
            year: 2027,
            month: 2,
            day: 28,
        });
    });
});

describe('resolveWarningDates', () => {
    const now = new Date('2026-09-01T20:00:00.000Z');

    it('defaults issued to Pacific today and drop-off to six months later', () => {
        const result = resolveWarningDates({ issuedInput: '', expiresInput: '', now });

        expect(result).toEqual({
            ok: true,
            issued: { year: 2026, month: 9, day: 1 },
            expires: { year: 2027, month: 3, day: 1 },
        });
    });

    it('allows a backdated issued date', () => {
        const result = resolveWarningDates({
            issuedInput: '2026-03-01',
            expiresInput: '',
            now,
        });

        expect(result).toEqual({
            ok: true,
            issued: { year: 2026, month: 3, day: 1 },
            expires: { year: 2026, month: 9, day: 1 },
        });
    });

    it('rejects an issued date in the future', () => {
        expect(resolveWarningDates({ issuedInput: '2026-09-02', expiresInput: '', now })).toEqual({
            ok: false,
            kind: 'issued-in-future',
        });
    });

    it('rejects a drop-off on or before the issued date', () => {
        expect(
            resolveWarningDates({
                issuedInput: '2026-09-01',
                expiresInput: '2026-09-01',
                now,
            })
        ).toEqual({
            ok: false,
            kind: 'expires-not-after-issued',
        });
    });

    it('rejects a drop-off that has already passed', () => {
        expect(
            resolveWarningDates({
                issuedInput: '2025-01-01',
                expiresInput: '',
                now,
            })
        ).toEqual({
            ok: false,
            kind: 'expires-already-passed',
        });
    });

    it('rejects invalid date strings', () => {
        expect(resolveWarningDates({ issuedInput: 'nope', expiresInput: '', now })).toEqual({
            ok: false,
            kind: 'invalid-issued',
        });
        expect(resolveWarningDates({ issuedInput: '', expiresInput: '2026-13-40', now })).toEqual({
            ok: false,
            kind: 'invalid-expires',
        });
    });
});

describe('isWarningActive', () => {
    const asOf = new Date('2026-09-01T20:00:00.000Z');

    it('treats a warning as active through its drop-off date', () => {
        expect(
            isWarningActive(
                { clearedAt: null, expiresAt: new Date('2026-09-01T00:00:00.000Z') },
                asOf
            )
        ).toBe(true);
    });

    it('expires the day after drop-off', () => {
        expect(
            isWarningActive(
                { clearedAt: null, expiresAt: new Date('2026-08-31T00:00:00.000Z') },
                asOf
            )
        ).toBe(false);
    });

    it('ignores cleared warnings even if they have not dropped off', () => {
        expect(
            isWarningActive(
                {
                    clearedAt: new Date('2026-08-15T00:00:00.000Z'),
                    expiresAt: new Date('2027-03-01T00:00:00.000Z'),
                },
                asOf
            )
        ).toBe(false);
    });
});

describe('compareCalendarDates', () => {
    it('orders dates', () => {
        expect(
            compareCalendarDates({ year: 2026, month: 9, day: 1 }, { year: 2026, month: 9, day: 2 })
        ).toBeLessThan(0);
        expect(formatCalendarDate({ year: 2026, month: 3, day: 1 })).toBe('2026-03-01');
    });
});
