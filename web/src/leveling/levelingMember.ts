/**
 * How a member holding XP is written on screen.
 *
 * `member` is null when the person has left the guild but their progress row survived —
 * the server sends null rather than a placeholder string precisely so the browser decides
 * how to say "no longer here" instead of parsing a sentinel out of a name field. Both
 * pages need that decision, so it lives here rather than twice in JSX.
 */

import type { LevelingMember } from '../api/types';

/** What a row or header needs to draw a person, with absence already resolved. */
export interface MemberPresentation {
    /** Always printable: a display name, or the id when Discord no longer knows them. */
    readonly name: string;
    /** The handle, when there is one. Null for a departed member — never a fabricated `@id`. */
    readonly handle: string | null;
    /** Null means "render the monogram", not "broken image". */
    readonly avatarUrl: string | null;
    /** Two letters for the avatar fallback. */
    readonly monogram: string;
    /** Whether Discord still resolves this id in the guild. Drives the "left" marker. */
    readonly departed: boolean;
    /** Bots earn XP like anyone else; the leaderboard says so rather than hiding it. */
    readonly isBot: boolean;
}

/**
 * Two letters for an avatar with no image, matching `DashboardLayout`'s monogram rule.
 *
 * Duplicated deliberately rather than exported from the layout: that copy takes a guild or
 * user name and this one has to survive a raw snowflake, and coupling a nav component to a
 * leaderboard row to share five lines is the worse trade.
 */
function monogramOf(name: string): string {
    const parts = name.trim().split(/\s+/);
    if (parts.length >= 2 && parts[0] && parts[1]) {
        return (parts[0][0] + parts[1][0]).toUpperCase();
    }
    return name.slice(0, 2).toUpperCase() || '??';
}

/**
 * Resolve a member for display, falling back to the id when they are gone.
 *
 * The id rather than "Unknown User": null means "Discord did not resolve this account",
 * not "this account has no name", and inventing a label would put a string on screen an
 * operator could not tell from somebody's actual nickname. The id is also the one thing
 * that stays useful — it can be pasted into Discord's search.
 */
export function memberPresentation(
    member: LevelingMember | null,
    userId: string
): MemberPresentation {
    if (!member) {
        return {
            name: userId,
            handle: null,
            avatarUrl: null,
            monogram: '??',
            departed: true,
            isBot: false,
        };
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
