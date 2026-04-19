import { describe, expect, it } from 'vitest';
import { parseBirthdayInput } from '../utils';

describe('parseBirthdayInput', () => {
    it('accepts an empty year as optional input', () => {
        const result = parseBirthdayInput('3', '15', '');

        expect(result.isValid).toBe(true);
        expect(result.data).toEqual({ month: 3, day: 15, year: null });
    });

    it('treats whitespace-only year input as optional', () => {
        const result = parseBirthdayInput('3', '15', '   ');

        expect(result.isValid).toBe(true);
        expect(result.data).toEqual({ month: 3, day: 15, year: null });
    });

    it('rejects invalid years when one is provided', () => {
        const result = parseBirthdayInput('3', '15', '1899');

        expect(result.isValid).toBe(false);
        expect(result.errorMessage).toContain('valid year between 1900');
    });
});
