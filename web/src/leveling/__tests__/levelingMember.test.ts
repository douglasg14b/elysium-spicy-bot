import type { MemberName } from '@brattybot/web-sdk';
import { describe, expect, it } from 'vitest';
import { memberPresentation } from '../levelingMember';

/**
 * How a member holding XP renders.
 *
 * The cases that matter are the departed ones: somebody who left the guild still holds
 * their progress row, so the leaderboard has to name them without Discord's help — from
 * the bot's memory of them when it has one — and without inventing a person.
 */

const DEPARTED_ID = '123456789012345678';

function remembered(overrides: Partial<MemberName> = {}): MemberName {
    return {
        userId: DEPARTED_ID,
        username: 'gonegirl',
        globalName: 'Gone Girl',
        nickname: 'Ex Brat',
        nicknames: ['Ex Brat'],
        isBot: false,
        inServer: false,
        leftAt: '2026-10-30T12:00:00.000Z',
        ...overrides,
    };
}

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
            '1',
            undefined
        );

        expect(presented.name).toBe('Kitten');
        expect(presented.handle).toBe('someuser');
        expect(presented.avatarUrl).toBe('https://cdn.discordapp.com/avatars/1/a.png');
        expect(presented.departed).toBe(false);
    });

    it('falls back to the id when the member has left the guild and the bot cannot name them', () => {
        // `member: null` is the server saying Discord did not resolve this account. The id
        // is the only true thing left, and it is at least pasteable into Discord's search.
        const presented = memberPresentation(null, DEPARTED_ID, undefined);

        expect(presented.name).toBe(DEPARTED_ID);
        expect(presented.departed).toBe(true);
        // No fabricated `@123456789012345678` — they have no handle we know of.
        expect(presented.handle).toBeNull();
        expect(presented.avatarUrl).toBeNull();
        expect(presented.monogram).toBe('??');
    });

    it('names somebody who left by what the bot remembers: nickname, then display name, then handle', () => {
        const nicknamed = memberPresentation(null, DEPARTED_ID, remembered());
        const displayNamed = memberPresentation(null, DEPARTED_ID, remembered({ nickname: null }));
        const handleOnly = memberPresentation(null, DEPARTED_ID, remembered({ nickname: null, globalName: null }));

        expect(nicknamed).toMatchObject({ name: 'Ex Brat', handle: 'gonegirl', monogram: 'EB', departed: true });
        expect(displayNamed.name).toBe('Gone Girl');
        expect(handleOnly.name).toBe('gonegirl');
        expect(nicknamed.avatarUrl).toBeNull();
    });

    it('prefers the live member over anything remembered', () => {
        const presented = memberPresentation(
            { userId: DEPARTED_ID, displayName: 'Back Again', username: 'gonegirl', avatarUrl: null, isBot: false },
            DEPARTED_ID,
            remembered()
        );

        expect(presented.name).toBe('Back Again');
        expect(presented.departed).toBe(false);
    });

    it('reports a null avatar rather than a broken image url', () => {
        // Null means "draw the monogram", not "the request failed".
        const presented = memberPresentation(
            { userId: '1', displayName: 'Brat', username: 'brat', avatarUrl: null, isBot: false },
            '1',
            undefined
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
            '1',
            undefined
        );

        expect(presented.monogram).toBe('VB');
    });

    it('falls back to the username when the display name is empty', () => {
        // An empty cell reads as a layout bug rather than a member Discord answered oddly
        // about, so the empty string is treated as absent rather than rendered.
        const presented = memberPresentation(
            { userId: '1', displayName: '', username: 'someuser', avatarUrl: null, isBot: false },
            '1',
            undefined
        );

        expect(presented.name).toBe('someuser');
    });

    it('falls back to the id when neither name has anything in it', () => {
        const presented = memberPresentation(
            { userId: '1', displayName: '', username: '', avatarUrl: null, isBot: false },
            '777',
            undefined
        );

        expect(presented.name).toBe('777');
        // Still resolved, not departed — Discord answered, it just answered uselessly.
        expect(presented.departed).toBe(false);
    });

    it('carries the bot flag through rather than hiding bots', () => {
        const presented = memberPresentation(
            { userId: '1', displayName: 'BrattyBot', username: 'brattybot', avatarUrl: null, isBot: true },
            '1',
            undefined
        );

        expect(presented.isBot).toBe(true);
    });
});
