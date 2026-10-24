import type { DiscordMessageInput } from './messageConfigSchema';
import { MESSAGE_LIMITS } from './messageLimits';
import { messageCharacterCount } from './messageParts';

/** Where a problem sits inside a message, as zod addresses a part: `['embeds', 1, 'footer']`. */
export type MessagePath = readonly (string | number)[];

/** One rule spanning parts that a message breaks, addressed to the part to fix. */
export interface MessageProblem {
    /** Relative to the message; `[]` is the message as a whole. */
    readonly path: MessagePath;
    readonly message: string;
}

/**
 * The rules no single part of a message can state, as problems addressed to their parts.
 *
 * Pure, and run on a message that already has the right shape — with its defaults filled or
 * not, so both the block's parsed value and the wire's can be asked: the block's schema calls
 * it from its `superRefine`, so each path lands under the field holding the message, and a
 * route holding a message calls it from its handler (a request schema refuses refinements).
 * Each sentence is the one the author reads, numbered from one as the editor numbers embeds.
 *
 * - The message needs plain text or at least one embed: Discord posts nothing otherwise.
 * - An embed needs something in it — Discord refuses an empty one.
 * - A header or footer needs text: Discord drops an icon on its own, and shows nothing for
 *   neither.
 * - The embeds' text together stays within Discord's 6000 characters. Counted outside any
 *   `{{token}}`, so a message is refused here only when its own words are over — a token can
 *   only add to them. A run counts again once the tokens are filled in, which is when the
 *   rest shows up.
 */
export function messageProblems(message: DiscordMessageInput): readonly MessageProblem[] {
    const problems: MessageProblem[] = [];

    if (!message.content && message.embeds.length === 0) {
        problems.push({
            path: [],
            message: "This message is empty. Give it some plain text or an embed — Discord won't post nothing.",
        });
    }

    const characters = messageCharacterCount(message, 'outsideTokens');
    if (characters > MESSAGE_LIMITS.totalCharacters) {
        problems.push({
            path: [],
            message:
                `This message's embeds hold ${characters} characters of text, and Discord's limit across all of them ` +
                `is ${MESSAGE_LIMITS.totalCharacters}. Trim a body or drop a field — each part fits on its own, it's ` +
                'the total that is over.',
        });
    }

    for (const [index, embed] of message.embeds.entries()) {
        const number = index + 1;
        const hasSomething =
            !!embed.title ||
            !!embed.description ||
            (embed.fields?.length ?? 0) > 0 ||
            !!embed.thumbnail ||
            !!embed.image ||
            !!embed.author?.name ||
            !!embed.footer?.text;
        if (!hasSomething) {
            problems.push({
                path: ['embeds', index],
                message: `Embed ${number} is empty — give it a title, some words, a field or a picture, or bin it.`,
            });
        }

        if (embed.author && !embed.author.name) {
            problems.push({
                path: ['embeds', index, 'author'],
                message: embed.author.iconUrl
                    ? `Embed ${number}'s header needs some text — Discord drops a header icon with nothing beside it.`
                    : `Embed ${number}'s header is empty — give it some text or take it off.`,
            });
        }

        if (embed.footer && !embed.footer.text) {
            problems.push({
                path: ['embeds', index, 'footer'],
                message: embed.footer.iconUrl
                    ? `Embed ${number}'s footer needs some text — Discord drops a footer icon with nothing beside it.`
                    : `Embed ${number}'s footer is empty — give it some text or take it off.`,
            });
        }
    }

    return problems;
}
