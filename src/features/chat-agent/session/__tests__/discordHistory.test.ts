import { describe, expect, it } from 'vitest';
import { cutText } from '../discordHistory';

describe('cutText', () => {
    it('cuts at the limit and says so', () => {
        expect(cutText('abcdef', 3)).toBe('abc …[cut]');
        expect(cutText('abc', 3)).toBe('abc');
    });

    it('never cuts through an emoji', () => {
        expect(cutText('ab😈cd', 3)).toBe('ab …[cut]');
        expect(cutText('ab😈cd', 4)).toBe('ab😈 …[cut]');
    });
});
