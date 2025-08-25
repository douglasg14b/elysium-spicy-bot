import { describe, it, expect } from 'vitest';
import { formatDuration } from '../formatDuration';

// Helper to convert h/m/s/d to ms
const ms = ({ d = 0, h = 0, m = 0, s = 0 }) => (d * 86400 + h * 3600 + m * 60 + s) * 1000;

describe('formatDuration', () => {
    it.each([
        [{ s: 45 }, '45s'],
        [{ s: 0 }, '0s'],
        [{ m: 2, s: 5 }, '2m 5s'],
        [{ m: 1, s: 0 }, '1m'],
        [{ h: 1, m: 23, s: 45 }, '1h 23m 45s'],
        [{ h: 2, m: 0, s: 0 }, '2h'],
        [{ d: 1, h: 2, m: 3, s: 4 }, '1d 2h 3m 4s'],
        [{ d: 3, h: 0, m: 0, s: 0 }, '3d'],
        [{ m: 0, s: 5 }, '5s'],
        [{ h: 0, m: 0, s: 10 }, '10s'],
        [{ d: 0, h: 0, m: 0, s: 0 }, '0s'],
    ])('formats %o as %s', (input, expected) => {
        expect(formatDuration(ms(input))).toBe(expected);
    });
});
