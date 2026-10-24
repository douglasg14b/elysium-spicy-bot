import { describe, expect, it } from 'vitest';
import { formatDay } from '../timestamps';

describe('formatDay', () => {
    const now = new Date('2026-10-24T12:00:00.000Z');

    it('leaves the year off this year, and puts it on any other', () => {
        expect(formatDay('2026-03-02T12:00:00.000Z', now)).not.toMatch(/2026/);
        expect(formatDay('2025-03-02T12:00:00.000Z', now)).toMatch(/2025/);
    });

    it('shows a dash for a stamp it cannot read', () => {
        expect(formatDay('not a date', now)).toBe('—');
    });
});
