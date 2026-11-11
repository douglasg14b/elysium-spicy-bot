import type { GuildMember } from 'discord.js';

/**
 * The words a pronoun set is made of. Each part of a role's name must be one, since this
 * server's roles are full of other slashes — `Dom/sub`, `Top/Bottom`, `Switch/Brat`.
 */
const PRONOUN_WORDS = new Set([
    'she', 'her', 'hers', 'he', 'him', 'his', 'they', 'them', 'their', 'theirs',
    'xe', 'xem', 'xyr', 'ze', 'zie', 'zir', 'hir', 'fae', 'faer', 'ey', 'em', 'eir',
    've', 'ver', 'it', 'its', 'any', 'all', 'ask',
]);

/** A role that says it is about pronouns — `Any Pronouns`, `Ask for pronouns`, `Pronouns: she/her`, `Neo Pronouns`. */
const NAMES_PRONOUNS = /\bpronouns?\b/i;

/** Emoji, symbols and punctuation at a role name's edges (`🌸 she/her`, `[they/them]`), which say nothing of the pronouns. */
const EDGES = /^[^\p{L}]+|[^\p{L}]+$/gu;

/**
 * Whether a role's name states pronouns. Discord does not show bots anyone's profile
 * pronouns, so a pronoun role (and what a member says in their intro) is all the agent has.
 */
export function isPronounRoleName(name: string): boolean {
    const words = name.toLowerCase().split(/[^a-z]+/).filter(Boolean);
    // "pronouns" alone is a divider (`━━ Pronouns ━━`, `Pronoun Roles`) that everyone may hold; it must say which.
    if (NAMES_PRONOUNS.test(name)) return words.some((word) => PRONOUN_WORDS.has(word) || word === 'neo');
    const parts = name.replace(EDGES, '').toLowerCase().split(/[/|-]/).map((part) => part.trim());
    return parts.length > 1 && parts.every((part) => PRONOUN_WORDS.has(part));
}

/** The names of `member`'s pronoun roles, highest first; empty when they have none. */
export function pronounRoles(member: GuildMember): string[] {
    return [...member.roles.cache.values()]
        .filter((role) => role.id !== member.guild.id && isPronounRoleName(role.name))
        .sort((left, right) => right.position - left.position)
        .map((role) => role.name.trim());
}
