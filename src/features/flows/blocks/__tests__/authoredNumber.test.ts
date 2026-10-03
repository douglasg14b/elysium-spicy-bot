import { describe, expect, it } from 'vitest';
import { notANumberMessage, parseAuthoredNumber, readNumber } from '../authoredNumber';

/**
 * The one reading of a typed or held number that Set Variable and Compare share: plain
 * decimal notation, never blank, and never a value too big to hold exactly.
 */

describe('reading a number an author typed', () => {
    it('never reads blank, or anything that is not a finite number, as one', () => {
        expect(parseAuthoredNumber(undefined)).toBeUndefined();
        expect(parseAuthoredNumber('')).toBeUndefined();
        expect(parseAuthoredNumber('  ')).toBeUndefined();
        expect(parseAuthoredNumber('Infinity')).toBeUndefined();
        expect(parseAuthoredNumber('12abc')).toBeUndefined();
        expect(parseAuthoredNumber('1.2.3')).toBeUndefined();
        expect(parseAuthoredNumber('.')).toBeUndefined();
        expect(parseAuthoredNumber('+')).toBeUndefined();
        // Plain decimal, but too long to be finite.
        expect(parseAuthoredNumber('1' + '0'.repeat(400))).toBeUndefined();
        expect(parseAuthoredNumber('0')).toBe(0);
    });

    it.each([['0x10'], ['0b101'], ['0o7'], ['1e3'], ['-1E-2']])(
        'refuses %s, which Number() would read but an author would not',
        (raw) => {
            expect(parseAuthoredNumber(raw)).toBeUndefined();
        }
    );

    it('reads plain decimal notation, signed or not, with or without a leading digit', () => {
        expect(parseAuthoredNumber('+3')).toBe(3);
        expect(parseAuthoredNumber('-0.5')).toBe(-0.5);
        expect(parseAuthoredNumber('.5')).toBe(0.5);
        expect(parseAuthoredNumber('5.')).toBe(5);
        expect(parseAuthoredNumber('007')).toBe(7);
    });

    it('refuses a number too big to hold exactly, so a snowflake ID stays text', () => {
        expect(parseAuthoredNumber('9007199254740991')).toBe(Number.MAX_SAFE_INTEGER);
        expect(parseAuthoredNumber('-9007199254740991')).toBe(-Number.MAX_SAFE_INTEGER);
        expect(parseAuthoredNumber('9007199254740993')).toBeUndefined();
        expect(parseAuthoredNumber('1234567890123456789')).toBeUndefined();
    });
});

describe('reading a held value as a number', () => {
    it('reads an exact number as itself and a numeric string as its number', () => {
        expect(readNumber(3)).toBe(3);
        expect(readNumber(' 5.0 ')).toBe(5);
    });

    it('reads no boolean, word, or number too big to hold exactly as one', () => {
        expect(readNumber(true)).toBeUndefined();
        expect(readNumber('abc')).toBeUndefined();
        expect(readNumber(Number.MAX_SAFE_INTEGER + 2)).toBeUndefined();
    });

    it('words a refusal the same for every block', () => {
        expect(notANumberMessage('lots')).toBe('"lots" is not a number. Digits, please — 3, -2, 0.5.');
    });
});
