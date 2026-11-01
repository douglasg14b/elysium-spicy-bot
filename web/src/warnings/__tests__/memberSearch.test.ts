import { describe, expect, it } from 'vitest';
import { memberSearchTerm } from '../memberSearch';

describe('memberSearchTerm', () => {
    it('asks nothing below two characters', () => {
        expect(memberSearchTerm('', null)).toBeNull();
        expect(memberSearchTerm(' k ', null)).toBeNull();
    });

    it('searches the trimmed text from two characters on', () => {
        expect(memberSearchTerm(' ki ', null)).toBe('ki');
    });

    it('asks nothing past the 32 characters a Discord name can have', () => {
        expect(memberSearchTerm('x'.repeat(32), null)).toBe('x'.repeat(32));
        expect(memberSearchTerm('x'.repeat(33), null)).toBeNull();
    });

    it("does not search again for the name picking wrote into the box", () => {
        expect(memberSearchTerm('Kitten', { displayName: 'Kitten' })).toBeNull();
        expect(memberSearchTerm('Kitt', { displayName: 'Kitten' })).toBe('Kitt');
    });
});
