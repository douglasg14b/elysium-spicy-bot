import { describe, expect, it } from 'vitest';
import { DISCORD_MESSAGE_LIMIT, MAX_REPLY_PARTS, toReplyParts } from '../replyText';

describe('toReplyParts', () => {
    it('keeps a short reply whole', () => {
        expect(toReplyParts('  Hi. Now say something worth scrolling for.  ')).toEqual([
            'Hi. Now say something worth scrolling for.',
        ]);
    });

    it('strips control characters and zero-width spaces', () => {
        expect(toReplyParts('a\u0000b​c\nd')).toEqual(['abc\nd']);
    });

    it('returns nothing for text with nothing in it', () => {
        expect(toReplyParts(' ​\n ')).toEqual([]);
    });

    it('splits a long reply on a paragraph break', () => {
        const first = 'a'.repeat(1500);
        const second = 'b'.repeat(800);
        expect(toReplyParts(`${first}\n\n${second}`)).toEqual([first, second]);
    });

    it('falls back to a sentence boundary when no paragraph break fits', () => {
        const first = `${'word '.repeat(300).trim()}.`;
        const second = 'x'.repeat(900);
        const parts = toReplyParts(`${first} ${second}`);
        expect(parts).toEqual([first, second]);
    });

    it(`never posts more than ${MAX_REPLY_PARTS} messages, and marks the cut`, () => {
        const parts = toReplyParts('word '.repeat(2000));
        expect(parts).toHaveLength(MAX_REPLY_PARTS);
        expect(parts.at(-1)?.endsWith(' …')).toBe(true);
        for (const part of parts) expect(part.length).toBeLessThanOrEqual(DISCORD_MESSAGE_LIMIT);
    });

    it('hard-cuts text with no boundary at all', () => {
        const parts = toReplyParts('x'.repeat(2500));
        expect(parts[0]).toHaveLength(DISCORD_MESSAGE_LIMIT);
        expect(parts[1]).toBe('x'.repeat(500));
    });
});
