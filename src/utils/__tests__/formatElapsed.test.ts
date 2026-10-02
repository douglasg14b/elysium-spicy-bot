import { describe, expect, it } from 'vitest';
import { formatElapsed } from '../formatElapsed';

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe('formatElapsed', () => {
    it.each([
        [0, '0 seconds'],
        [1 * SECOND, '1 second'],
        [45 * MINUTE, '45 minutes'],
        [23 * HOUR + 59 * MINUTE, '23 hours'],
        [3 * DAY + 4 * HOUR, '3 days'],
        [61 * DAY, '2 months'],
        [364 * DAY, '12 months'],
        [400 * DAY, '1 year'],
        [3 * 365 * DAY, '3 years'],
    ])('reads %i ms as "%s"', (ms, expected) => {
        expect(formatElapsed(ms)).toBe(expected);
    });

    it('floors rather than rounds, so nearly a day is still hours', () => {
        expect(formatElapsed(DAY - 1)).toBe('23 hours');
    });

    it('reads a negative span as no time at all', () => {
        expect(formatElapsed(-5 * MINUTE)).toBe('0 seconds');
    });
});
