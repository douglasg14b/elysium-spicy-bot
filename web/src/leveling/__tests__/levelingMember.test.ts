import { describe, expect, it } from 'vitest';
import { memberPresentation } from '../levelingMember';

/**
 * How a member holding XP renders.
 *
 * The case that matters is the third: somebody who left the guild still holds their
 * progress row, so the leaderboard has to name them without Discord's help and without
 * inventing a person.
 */

describe('memberPresentation', () => {
    it('uses the display name and keeps the handle beside it', () => {
        const presented = memberPresentation(
            {
                userId: '1',
                displayName: 'Kitten',
                username: 'someuser',
                avatarUrl: 'https://cdn.discordapp.com/avatars/1/a.png',
                isBot: false,
            },
            '1'
        );

        expect(presented.name).toBe('Kitten');
        expect(presented.handle).toBe('someuser');
        expect(presented.avatarUrl).toBe('https://cdn.discordapp.com/avatars/1/a.png');
        expect(presented.departed).toBe(false);
    });

    it('falls back to the id when the member has left the guild', () => {
        // `member: null` is the server saying Discord did not resolve this account. The id
        // is the only true thing left, and it is at least pasteable into Discord's search.
        const presented = memberPresentation(null, '123456789012345678');

        expect(presented.name).toBe('123456789012345678');
        expect(presented.departed).toBe(true);
        // No fabricated `@123456789012345678` — they have no handle we know of.
        expect(presented.handle).toBeNull();
        expect(presented.avatarUrl).toBeNull();
        expect(presented.monogram).toBe('??');
    });

    it('reports a null avatar rather than a broken image url', () => {
        // Null means "draw the monogram", not "the request failed".
        const presented = memberPresentation(
            { userId: '1', displayName: 'Brat', username: 'brat', avatarUrl: null, isBot: false },
            '1'
        );

        expect(presented.avatarUrl).toBeNull();
        expect(presented.monogram).toBe('BR');
    });

    it('builds a two-word monogram from initials', () => {
        const presented = memberPresentation(
            {
                userId: '1',
                displayName: 'Very Bad Influence',
                username: 'vbi',
                avatarUrl: null,
                isBot: false,
            },
            '1'
        );

        expect(presented.monogram).toBe('VB');
    });

    it('falls back to the username when the display name is empty', () => {
        // An empty cell reads as a layout bug rather than a member Discord answered oddly
        // about, so the empty string is treated as absent rather than rendered.
        const presented = memberPresentation(
            { userId: '1', displayName: '', username: 'someuser', avatarUrl: null, isBot: false },
            '1'
        );

        expect(presented.name).toBe('someuser');
    });

    it('falls back to the id when neither name has anything in it', () => {
        const presented = memberPresentation(
            { userId: '1', displayName: '', username: '', avatarUrl: null, isBot: false },
            '777'
        );

        expect(presented.name).toBe('777');
        // Still resolved, not departed — Discord answered, it just answered uselessly.
        expect(presented.departed).toBe(false);
    });

    it('carries the bot flag through rather than hiding bots', () => {
        const presented = memberPresentation(
            { userId: '1', displayName: 'BrattyBot', username: 'brattybot', avatarUrl: null, isBot: true },
            '1'
        );

        expect(presented.isBot).toBe(true);
    });
});
