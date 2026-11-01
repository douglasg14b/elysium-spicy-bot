/**
 * How a member holding XP is written on screen.
 *
 * `member` is null when the person has left the guild but their progress row survived —
 * the server sends null rather than a placeholder string precisely so the browser decides
 * how to say "no longer here" instead of parsing a sentinel out of a name field. Both
 * pages need that decision, so it lives here rather than twice in JSX.
 */

import type { LevelingMember, MemberName } from '@brattybot/web-sdk';
import { monogramOf, rememberedFace, unrememberedFace, type MemberFace } from '../members/memberFace';

/** What a row or header needs to draw a person, with absence already resolved. */
export interface MemberPresentation extends MemberFace {
    /** Whether Discord still resolves this id in the guild. Drives the "left" marker. */
    readonly departed: boolean;
    /** Bots earn XP like anyone else; the leaderboard says so rather than hiding it. */
    readonly isBot: boolean;
}

/**
 * Resolve a member for display. Somebody who is gone is named by the bot's memory of them
 * (`remembered`, from `useMemberNames`) — the name they went by, their handle, and the
 * avatar the bot kept — and by the id when it has none. A current member keeps Discord's
 * live avatar link.
 *
 * The id rather than "Unknown User": null means "Discord did not resolve this account",
 * not "this account has no name", and inventing a label would put a string on screen an
 * operator could not tell from somebody's actual nickname. The id is also the one thing
 * that stays useful — it can be pasted into Discord's search.
 */
export function memberPresentation(
    member: LevelingMember | null,
    userId: string,
    remembered: MemberName | undefined
): MemberPresentation {
    if (!member) {
        if (remembered) {
            return { ...rememberedFace(remembered), departed: true, isBot: remembered.isBot };
        }
        return { ...unrememberedFace(userId), monogram: '??', departed: true, isBot: false };
    }

    // `||` rather than `??`: an empty display name is as unusable as a missing one, and an
    // empty cell reads as a layout bug rather than a member Discord answered oddly about.
    const name = member.displayName || member.username || userId;

    return {
        name,
        handle: member.username || null,
        avatarUrl: member.avatarUrl,
        monogram: monogramOf(name),
        departed: false,
        isBot: member.isBot,
    };
}
