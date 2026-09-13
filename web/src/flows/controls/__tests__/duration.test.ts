/**
 * The duration control's unit arithmetic — the half of that control that can be
 * tested without a DOM.
 */

import { describe, expect, it } from 'vitest';
import { nextDurationValue, splitDuration } from '../duration';

describe('splitDuration', () => {
    it('defaults to minutes when there is no value', () => {
        expect(splitDuration(null)).toEqual({ value: null, unit: 60_000 });
    });

    it('treats a non-positive duration as no value', () => {
        expect(splitDuration(0)).toEqual({ value: null, unit: 60_000 });
        expect(splitDuration(-1)).toEqual({ value: null, unit: 60_000 });
    });

    it('picks the largest unit that divides evenly', () => {
        expect(splitDuration(86_400_000)).toEqual({ value: 1, unit: 86_400_000 });
        expect(splitDuration(3_600_000)).toEqual({ value: 1, unit: 3_600_000 });
        expect(splitDuration(300_000)).toEqual({ value: 5, unit: 60_000 });
        expect(splitDuration(5_000)).toEqual({ value: 5, unit: 1_000 });
    });

    it('falls back to whole seconds when nothing divides evenly', () => {
        // 90s is not a whole number of minutes, so it shows as seconds.
        expect(splitDuration(90_000)).toEqual({ value: 90, unit: 1_000 });
        expect(splitDuration(1_500)).toEqual({ value: 2, unit: 1_000 });
    });
});

describe('nextDurationValue', () => {
    it('multiplies the amount by its unit', () => {
        expect(nextDurationValue(5, 60_000, false)).toBe(300_000);
        expect(nextDurationValue(1, 86_400_000, true)).toBe(86_400_000);
    });

    it('rounds a fractional amount to whole milliseconds', () => {
        expect(nextDurationValue(1.5, 1_000, false)).toBe(1_500);
    });

    // The distinction the whole control exists to preserve. An optional duration
    // clears to absence, which its schema allows; a required one clears to a value
    // its schema rejects, so the save fails loudly instead of the key vanishing.
    it('clears an optional duration to absence', () => {
        expect(nextDurationValue(null, 60_000, true)).toBeUndefined();
        expect(nextDurationValue(0, 60_000, true)).toBeUndefined();
        expect(nextDurationValue(-1, 60_000, true)).toBeUndefined();
        expect(nextDurationValue(Number.NaN, 60_000, true)).toBeUndefined();
    });

    it('clears a required duration to zero, which the schema rejects', () => {
        expect(nextDurationValue(null, 60_000, false)).toBe(0);
        expect(nextDurationValue(0, 60_000, false)).toBe(0);
        expect(nextDurationValue(-1, 60_000, false)).toBe(0);
        expect(nextDurationValue(Number.NaN, 60_000, false)).toBe(0);
    });
});
