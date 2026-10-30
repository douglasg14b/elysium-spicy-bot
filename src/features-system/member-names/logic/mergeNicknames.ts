import { MEMBER_NICKNAME_HISTORY_CAP } from '../data/memberNamesSchema';

/**
 * The nicknames a member has been seen with, once `nickname` is seen: it moves to the front
 * (or joins there), each name appears once, and the oldest beyond the cap fall off.
 *
 * No nickname adds nothing: having none is not a name, and the list is of names they used.
 * Compared exactly — a nickname differing only in case is a different nickname.
 */
export function mergeNicknames(nicknames: readonly string[], nickname: string | null): string[] {
    if (!nickname) return [...nicknames];
    return [nickname, ...nicknames.filter((seen) => seen !== nickname)].slice(0, MEMBER_NICKNAME_HISTORY_CAP);
}
