/**
 * Why a message resource would be refused by the journey save, judged in the browser — so the
 * Resources list can hold the save back rather than send it and have it refused.
 *
 * ## Why a refused save cannot simply be shown
 *
 * A refused journey save re-reads the stored list over the screen (`useResourceAutosave`),
 * and a message being edited is refusable mid-edit as a matter of course: a fresh empty embed,
 * an icon added before its text, a picture link half typed. Sending those would revert the
 * window under the author's hands. So `isWorthSaving` holds the whole list while this reports
 * anything, and the row's red `messageNotSaveable` chip says why (pick 12 of
 * `docs/plans/message-resource-step-2.md`).
 *
 * ## What it mirrors
 *
 * `messageResourceProblems` in `src/features/provisioning/logic/`, behind the route's schema —
 * the same stages, in the same order, with the same sentences:
 *
 *  1. **The wire's schema**: the SDK's `zDiscordMessage` and `MessageButton` rules (each part's
 *     length, the title link's form, a button's key, label, style and emoji, at most 25
 *     buttons). The server refuses on these before asking anything else, so only these are
 *     reported when any fails. Sorted into the server's own field order, which the generated
 *     schema does not keep.
 *  2. **The message as Post Embed takes it** (`messageConfigSchema`): each picture an upload, a
 *     link or a token, and the rules spanning parts (`messageProblems`: an empty message, an empty
 *     embed, a lone header or footer icon, more than 6000 characters).
 *  3. **Each button has something to press**: a label or an emoji, and an emoji that is one — a
 *     server emoji's name Discord's `[A-Za-z0-9_]{2,32}`, a standard one's a single emoji, and
 *     only a server emoji animated.
 *  4. **No `{{tokens}}`** in the copy, a picture, or a button's label.
 *  5. **Each button its own key.**
 *
 * The browser cannot import the bot's tree, so stages 2–5 are written out here, and
 * `src/features/provisioning/logic/__tests__/messageResourceProblemsDrift.test.ts` runs the
 * server's rules and this over one table.
 *
 * **Not mirrored**: whether a title link or a picture link parses as a URL (`URL.canParse`), and
 * the uploads' sizes and owner, which need this server's database. Those are rare and stay
 * wrong until fixed, so the server's refusal names them in the error banner.
 */

import {
    zDiscordMessage,
    zResourceDeclaration,
    type DiscordMessage,
    type MessageButtonEmoji,
    type ResourceDeclaration,
} from '@brattybot/web-sdk';
import type { NestedIssue } from './controls/types';
import { messageCharacterCount, MESSAGE_TOTAL_CHARACTERS } from './messageEditor/messageCharacters';
import { partLabel, type PicturePart, type TextPart } from './messageEditor/messageDraft';
import { TOKEN_PATTERN } from './variables';

/** One reason a message resource would be refused, and the part to fix. */
export interface MessageResourceProblem {
    /**
     * Where it sits, dotted: inside the message (`message.embeds.1.title`, or `message` for the
     * message as a whole), or on a button (`buttons.2.label`, `buttons.2.emoji`, `buttons.2.emoji.id`,
     * `buttons.2`).
     */
    readonly path: string;
    /**
     * The part as the server's refusal names it — `embed 2 footer`, `button 3` — or absent for
     * the message as a whole. `"Rules panel" embed 2 footer: …` is the save's wording.
     */
    readonly where?: string;
    readonly message: string;
}

/** Copy holding a `{{token}}`: a posted message has no run to fill one in. The server's sentence. */
const TOKEN_IN_TEXT =
    "No tokens here — this message sits in its channel for everyone, so there's nobody to fill {{…}} in for, " +
    'and it would go out braces and all. Spell it out.';

/** A picture holding a `{{token}}`, for the same reason. */
const TOKEN_IN_PICTURE =
    "No tokens here — this message sits in its channel for everyone, so there's nobody to fill {{…}} in for. " +
    'Pick an upload or paste a link.';

/** A button with nothing on its face. The server's sentence. */
const NOTHING_TO_PRESS = 'A button needs a label or an emoji — something to press.';

/** A button emoji that is not one, or a standard one claiming to be animated. The server's sentence. */
const NOT_AN_EMOJI = "That's not an emoji.";

/** A server emoji's name, as Discord allows one — the server's `SERVER_EMOJI_NAME_PATTERN`. */
const SERVER_EMOJI_NAME = /^[A-Za-z0-9_]{2,32}$/;

/** `pictureRefSchema`'s sentence: a picture that is none of an upload, a link or a token. */
const NOT_A_PICTURE =
    'A picture takes an upload, a full http:// or https:// link, or a token like {{subject.avatarUrl}}.';

/**
 * The token pattern without its global flag. `TOKEN_PATTERN` is `/g`, so `.test` on it keeps
 * `lastIndex` between calls and answers every other one wrongly.
 */
const ONE_TOKEN = new RegExp(TOKEN_PATTERN.source);

/** An upload, exactly as the server reads one: `upload:` and a lowercase UUID. */
const UPLOAD_REF = /^upload:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The shared link pattern — the one the wire's title link carries, read off the SDK. */
const HTTP_LINK = linkPattern();

type Path = readonly (string | number)[];

function holdsToken(text: string): boolean {
    return ONE_TOKEN.test(text);
}

/** Unicode's recommended emoji, one and whole — the server's `RGI_EMOJI`. */
const RGI_EMOJI = new RegExp('^\\p{RGI_Emoji}$', 'v');

/** Whether `name` is one standard emoji — the server's `isOneEmoji`, line for line. */
function isOneEmoji(name: string): boolean {
    return RGI_EMOJI.test(name) || RGI_EMOJI.test(`${name}\u{FE0F}`);
}

/** What is wrong with a button's emoji, or nothing — the server's `emojiProblem`. */
function emojiProblem(emoji: MessageButtonEmoji): string | undefined {
    if (emoji.id) return SERVER_EMOJI_NAME.test(emoji.name) ? undefined : NOT_AN_EMOJI;
    return isOneEmoji(emoji.name) && emoji.animated !== true ? undefined : NOT_AN_EMOJI;
}

/**
 * The server's link pattern, from the title link's rule in the generated schema, so a picture
 * link is judged by the same characters the server's `HTTP_LINK_PATTERN` holds.
 */
function linkPattern(): RegExp {
    const url = zDiscordMessage.shape.embeds.element.shape.url.unwrap();
    const pattern = url._zod.bag.patterns?.values().next().value;
    if (!(pattern instanceof RegExp)) {
        throw new Error('The generated contract carries no pattern for a title link, so a picture link cannot be judged.');
    }
    return pattern;
}

/** Whether a picture string is one the server's `pictureRefSchema` takes. */
function isPicture(value: string): boolean {
    return UPLOAD_REF.test(value) || holdsToken(value) || HTTP_LINK.test(value);
}

/**
 * The order the server's schema meets an embed's parts — `messageShape`'s own field order,
 * which the generated schema (alphabetical) does not keep. Ranks a wire issue so the first
 * problem reported is the server's first.
 */
const EMBED_FIELD_ORDER = ['color', 'author', 'title', 'url', 'description', 'fields', 'thumbnail', 'image', 'footer', 'timestamp'];
const PAIR_ORDER: Readonly<Record<string, number>> = { name: 0, text: 0, iconUrl: 1 };
const FIELD_ORDER: Readonly<Record<string, number>> = { name: 0, value: 1, inline: 2 };
/** `MessageButtonSchema`'s field order, and its emoji's. */
const BUTTON_FIELD_ORDER: Readonly<Record<string, number>> = { key: 0, label: 1, style: 2, emoji: 3 };
const EMOJI_FIELD_ORDER: Readonly<Record<string, number>> = { name: 0, id: 1, animated: 2 };

/** A sort key for an issue's path, in the server's walking order. */
function rankOf(path: Path): number[] {
    const [root, ...rest] = path;
    if (root === 'buttons') {
        const [index, field, inner] = rest;
        return [
            2,
            typeof index === 'number' ? index : -1,
            typeof field === 'string' ? (BUTTON_FIELD_ORDER[field] ?? 4) : -1,
            typeof inner === 'string' ? (EMOJI_FIELD_ORDER[inner] ?? 3) : -1,
        ];
    }
    const [first, embed, field, inner, leaf] = rest;
    if (first === 'content') return [1, 0];
    if (first !== 'embeds' || typeof embed !== 'number') return [1, 1];
    const fieldRank = typeof field === 'string' ? EMBED_FIELD_ORDER.indexOf(field) : -1;
    const innerRank =
        field === 'fields'
            ? [typeof inner === 'number' ? inner : -1, typeof leaf === 'string' ? (FIELD_ORDER[leaf] ?? 3) : -1]
            : [typeof inner === 'string' ? (PAIR_ORDER[inner] ?? 2) : -1];
    return [1, 2, embed, fieldRank, ...innerRank];
}

function compareRanks(first: readonly number[], second: readonly number[]): number {
    for (let index = 0; index < Math.max(first.length, second.length); index += 1) {
        const difference = (first[index] ?? -2) - (second[index] ?? -2);
        if (difference !== 0) return difference;
    }
    return 0;
}

/**
 * The text part or picture a path inside the message names — only the ones the server's walk
 * (`messageCopyLocations`, `messagePictures`) knows, which is every part but the title link.
 */
function partAt(path: Path): TextPart | PicturePart | undefined {
    const [first, embed, field, inner, leaf] = path;
    if (first === 'content' && path.length === 1) return { kind: 'content' };
    if (first !== 'embeds' || typeof embed !== 'number') return undefined;
    if (path.length === 3) {
        switch (field) {
            case 'title':
            case 'description':
            case 'thumbnail':
            case 'image':
                return { kind: field, embed };
            default:
                return undefined;
        }
    }
    if (field === 'author' && path.length === 4) {
        return inner === 'name' ? { kind: 'authorName', embed } : inner === 'iconUrl' ? { kind: 'authorIcon', embed } : undefined;
    }
    if (field === 'footer' && path.length === 4) {
        return inner === 'text' ? { kind: 'footerText', embed } : inner === 'iconUrl' ? { kind: 'footerIcon', embed } : undefined;
    }
    if (field === 'fields' && typeof inner === 'number' && path.length === 5) {
        return leaf === 'name'
            ? { kind: 'fieldName', embed, field: inner }
            : leaf === 'value'
              ? { kind: 'fieldValue', embed, field: inner }
              : undefined;
    }
    return undefined;
}

/**
 * Where a problem at `path` (inside the message) sits, as the server's `whereIn` names it: the
 * part itself, else the embed it is inside, else nothing — the message as a whole. Named by the
 * window's own `partLabel`, which `messageMeterDrift.test.ts` already holds to the server's.
 */
function whereIn(path: Path): string | undefined {
    const part = partAt(path);
    if (part) {
        const label = partLabel(part);
        return label.charAt(0).toLowerCase() + label.slice(1);
    }
    const [first, embed] = path;
    return first === 'embeds' && typeof embed === 'number' ? `embed ${embed + 1}` : undefined;
}

function inMessage(path: Path, message: string): MessageResourceProblem {
    const where = whereIn(path);
    return { path: ['message', ...path].join('.'), ...(where ? { where } : {}), message };
}

function onButton(index: number, path: Path, message: string): MessageResourceProblem {
    return { path: ['buttons', index, ...path].join('.'), where: `button ${index + 1}`, message };
}

/** Stage 1: the wire's own rules, sorted into the order the server's schema meets them. */
function wireProblems(resource: ResourceDeclaration): MessageResourceProblem[] {
    const issues: { readonly path: Path; readonly message: string }[] = [];
    const message = zDiscordMessage.safeParse(resource.message);
    if (!message.success) {
        issues.push(...message.error.issues.map((issue) => ({ path: ['message', ...(issue.path as Path)], message: issue.message })));
    }
    const buttons = zResourceDeclaration.shape.buttons.safeParse(resource.buttons);
    if (!buttons.success) {
        issues.push(...buttons.error.issues.map((issue) => ({ path: ['buttons', ...(issue.path as Path)], message: issue.message })));
    }

    return [...issues]
        .sort((first, second) => compareRanks(rankOf(first.path), rankOf(second.path)))
        .map(({ path, message: sentence }) => {
            const [root, ...rest] = path;
            if (root === 'buttons') {
                const [index, ...inside] = rest;
                return typeof index === 'number'
                    ? onButton(index, inside, sentence)
                    : { path: 'buttons', message: sentence };
            }
            return inMessage(rest, sentence);
        });
}

/** Every picture part a message holds, with its path, in the order a reader meets them. */
function picturesOf(message: DiscordMessage): { readonly path: Path; readonly value: string }[] {
    return message.embeds.flatMap((embed, index) => {
        const pictures: { readonly path: Path; readonly value: string | undefined }[] = [
            { path: ['embeds', index, 'author', 'iconUrl'], value: embed.author?.iconUrl },
            { path: ['embeds', index, 'thumbnail'], value: embed.thumbnail },
            { path: ['embeds', index, 'image'], value: embed.image },
            { path: ['embeds', index, 'footer', 'iconUrl'], value: embed.footer?.iconUrl },
        ];
        return pictures.flatMap(({ path, value }) => (value === undefined ? [] : [{ path, value }]));
    });
}

/**
 * Every string in the message a token could hide in, in the server's walking order
 * (`messageCopyLocations`): the plain text, then each embed's header, header icon, title, body,
 * thumbnail, fields, image, footer and footer icon. An upload is left out — it holds no braces.
 */
function copyOf(message: DiscordMessage): { readonly path: Path; readonly value: string; readonly picture: boolean }[] {
    const parts: { readonly path: Path; readonly value: string | undefined; readonly picture: boolean }[] = [
        { path: ['content'], value: message.content, picture: false },
    ];
    message.embeds.forEach((embed, index) => {
        const at = (...rest: Path): Path => ['embeds', index, ...rest];
        parts.push(
            { path: at('author', 'name'), value: embed.author?.name, picture: false },
            { path: at('author', 'iconUrl'), value: embed.author?.iconUrl, picture: true },
            { path: at('title'), value: embed.title, picture: false },
            { path: at('description'), value: embed.description, picture: false },
            { path: at('thumbnail'), value: embed.thumbnail, picture: true },
            ...(embed.fields ?? []).flatMap((field, fieldIndex) => [
                { path: at('fields', fieldIndex, 'name'), value: field.name, picture: false },
                { path: at('fields', fieldIndex, 'value'), value: field.value, picture: false },
            ]),
            { path: at('image'), value: embed.image, picture: true },
            { path: at('footer', 'text'), value: embed.footer?.text, picture: false },
            { path: at('footer', 'iconUrl'), value: embed.footer?.iconUrl, picture: true }
        );
    });
    return parts.flatMap(({ path, value, picture }) =>
        value === undefined || (picture && UPLOAD_REF.test(value)) ? [] : [{ path, value, picture }]
    );
}

/** Stage 2's rules spanning parts: a mirror of `messageProblems`, sentence for sentence. */
function spanningProblems(message: DiscordMessage): MessageResourceProblem[] {
    const problems: MessageResourceProblem[] = [];

    if (!message.content && message.embeds.length === 0) {
        problems.push(inMessage([], "This message is empty. Give it some plain text or an embed — Discord won't post nothing."));
    }

    const characters = messageCharacterCount(message);
    if (characters > MESSAGE_TOTAL_CHARACTERS) {
        problems.push(
            inMessage(
                [],
                `This message's embeds hold ${characters} characters of text, and Discord's limit across all of them ` +
                    `is ${MESSAGE_TOTAL_CHARACTERS}. Trim a body or drop a field — each part fits on its own, it's ` +
                    'the total that is over.'
            )
        );
    }

    message.embeds.forEach((embed, index) => {
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
            problems.push(
                inMessage(['embeds', index], `Embed ${number} is empty — give it a title, some words, a field or a picture, or bin it.`)
            );
        }
        if (embed.author && !embed.author.name) {
            problems.push(
                inMessage(
                    ['embeds', index, 'author'],
                    embed.author.iconUrl
                        ? `Embed ${number}'s header needs some text — Discord drops a header icon with nothing beside it.`
                        : `Embed ${number}'s header is empty — give it some text or take it off.`
                )
            );
        }
        if (embed.footer && !embed.footer.text) {
            problems.push(
                inMessage(
                    ['embeds', index, 'footer'],
                    embed.footer.iconUrl
                        ? `Embed ${number}'s footer needs some text — Discord drops a footer icon with nothing beside it.`
                        : `Embed ${number}'s footer is empty — give it some text or take it off.`
                )
            );
        }
    });

    return problems;
}

/**
 * Why the journey save would refuse this message resource, in the order the server finds them,
 * or nothing when it would take it. Anything but a `message` with a message in it has nothing to
 * judge here: that a message resource carries one is the structural rule the server asks on its
 * own, and the panel never makes one without.
 */
export function messageResourceProblems(resource: ResourceDeclaration): readonly MessageResourceProblem[] {
    if (resource.kind !== 'message' || !resource.message) return [];

    const wire = wireProblems(resource);
    if (wire.length > 0) return wire;

    const message = resource.message;
    const problems: MessageResourceProblem[] = [];

    for (const picture of picturesOf(message)) {
        if (!isPicture(picture.value)) problems.push(inMessage(picture.path, NOT_A_PICTURE));
    }
    problems.push(...spanningProblems(message));

    const buttons = resource.buttons ?? [];
    buttons.forEach((button, index) => {
        if (!button.label && !button.emoji) problems.push(onButton(index, [], NOTHING_TO_PRESS));
        const emojiIssue = button.emoji && emojiProblem(button.emoji);
        if (emojiIssue) problems.push(onButton(index, ['emoji'], emojiIssue));
    });

    for (const part of copyOf(message)) {
        if (holdsToken(part.value)) problems.push(inMessage(part.path, part.picture ? TOKEN_IN_PICTURE : TOKEN_IN_TEXT));
    }

    buttons.forEach((button, index) => {
        if (button.label && holdsToken(button.label)) problems.push(onButton(index, [], TOKEN_IN_TEXT));
    });

    const seenKeys = new Set<string>();
    buttons.forEach((button, index) => {
        if (seenKeys.has(button.key)) {
            problems.push(
                onButton(
                    index,
                    [],
                    `Another button on this message already has the key "${button.key}". Give each its own — it's how a press finds its way.`
                )
            );
        }
        seenKeys.add(button.key);
    });

    return problems;
}

/** The problems inside the message, addressed relative to it, as the message window places them. */
export function messagePartIssues(problems: readonly MessageResourceProblem[]): NestedIssue[] {
    return problems.flatMap((problem) => {
        if (problem.path === 'message') return [{ path: '', message: problem.message }];
        return problem.path.startsWith('message.') ? [{ path: problem.path.slice('message.'.length), message: problem.message }] : [];
    });
}

/** The problems on each button, by its position; a problem with the list as a whole under `-1`. */
export function buttonIssues(problems: readonly MessageResourceProblem[]): ReadonlyMap<number, readonly string[]> {
    const byButton = new Map<number, string[]>();
    for (const problem of problems) {
        const match = /^buttons(?:\.(\d+))?/.exec(problem.path);
        if (!match) continue;
        const index = match[1] === undefined ? -1 : Number(match[1]);
        byButton.set(index, [...(byButton.get(index) ?? []), problem.message]);
    }
    return byButton;
}

/** One problem as the save's refusal words it, after the message's name: `embed 2 footer: …`, or the sentence alone. */
export function describeMessageResourceProblem(problem: MessageResourceProblem): string {
    return problem.where ? `${problem.where}: ${problem.message}` : problem.message;
}
