import { describe, expect, it } from 'vitest';
import { isWarningActive, warningStatus } from '../logic/warningStatus';

/**
 * The one statement of a warning's status. "Today" is the Pacific calendar day, so the
 * moments below are chosen on both sides of UTC midnight: 2026-09-02T03:00Z is still
 * 2026-09-01 in Los Angeles.
 */
describe('warningStatus', () => {
    const asOf = new Date('2026-09-01T20:00:00.000Z');

    it('is active through its drop-off day', () => {
        expect(warningStatus({ clearedAt: null, expiresAt: new Date('2026-09-01T00:00:00.000Z') }, asOf)).toBe(
            'active'
        );
    });

    it('is expired the day after its drop-off', () => {
        expect(warningStatus({ clearedAt: null, expiresAt: new Date('2026-08-31T00:00:00.000Z') }, asOf)).toBe(
            'expired'
        );
    });

    it('judges the day on the Pacific calendar, not the UTC one', () => {
        const evening = new Date('2026-09-02T03:00:00.000Z');
        const morning = new Date('2026-09-02T08:00:00.000Z');
        const dropsOffSeptemberFirst = { clearedAt: null, expiresAt: new Date('2026-09-01T00:00:00.000Z') };

        expect(warningStatus(dropsOffSeptemberFirst, evening)).toBe('active');
        expect(warningStatus(dropsOffSeptemberFirst, morning)).toBe('expired');
    });

    it('is released once cleared, whether or not it had dropped off', () => {
        const clearedAt = new Date('2026-08-15T00:00:00.000Z');

        expect(warningStatus({ clearedAt, expiresAt: new Date('2027-03-01T00:00:00.000Z') }, asOf)).toBe('released');
        expect(warningStatus({ clearedAt, expiresAt: new Date('2026-08-20T00:00:00.000Z') }, asOf)).toBe('released');
    });
});

describe('isWarningActive', () => {
    const asOf = new Date('2026-09-01T20:00:00.000Z');

    it('is true only for an active warning', () => {
        expect(isWarningActive({ clearedAt: null, expiresAt: new Date('2026-09-01T00:00:00.000Z') }, asOf)).toBe(true);
        expect(isWarningActive({ clearedAt: null, expiresAt: new Date('2026-08-31T00:00:00.000Z') }, asOf)).toBe(false);
        expect(
            isWarningActive(
                { clearedAt: new Date('2026-08-15T00:00:00.000Z'), expiresAt: new Date('2027-03-01T00:00:00.000Z') },
                asOf
            )
        ).toBe(false);
    });
});
