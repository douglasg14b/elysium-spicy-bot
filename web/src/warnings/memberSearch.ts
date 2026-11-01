import type { GuildMemberMatch } from '@brattybot/web-sdk';

/** Fewer characters than this match half the server and spend a Discord request doing it. */
export const MEMBER_SEARCH_MIN_LENGTH = 2;

/** Discord caps usernames and nicknames at 32 characters, so a longer search matches nobody. */
const MEMBER_SEARCH_MAX_LENGTH = 32;

/**
 * What the member picker should search for, or null when nothing should be asked.
 *
 * Null below two characters, past Discord's 32 (the route would refuse it, and nobody is
 * named that), and while the box only shows the member already picked: picking writes their
 * name into the box, and searching for it again would spend a request learning nothing.
 */
export function memberSearchTerm(typed: string, picked: Pick<GuildMemberMatch, 'displayName'> | null): string | null {
    const term = typed.trim();
    if (term.length < MEMBER_SEARCH_MIN_LENGTH || term.length > MEMBER_SEARCH_MAX_LENGTH) return null;
    if (picked && term === picked.displayName) return null;
    return term;
}
