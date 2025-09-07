import { describe, test, expect } from 'vitest';
import { stringToTitleCase } from '../stringToTitleCase';

const cases = [
    ['hello world', 'Hello world'],
    ['HelloWorld', 'Hello World'],
    ['already Title', 'Already Title'],
    ['multipleWordsTogether', 'Multiple Words Together'],
    ['a', 'A'],
    ['', ''],
];

describe('stringToTitleCase', () => {
    test.each(cases)('converts "%s" to "%s"', (input, expected) => {
        expect(stringToTitleCase(input)).toBe(expected);
    });
});
