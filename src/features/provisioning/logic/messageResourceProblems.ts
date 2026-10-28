import { holdsCopyToken } from '../../../shared/copyTokens';
import { messageConfigSchema, messageCopyLocations, messagePictures } from '../../../shared/discordMessage';
import { isOneEmoji, SERVER_EMOJI_NAME_PATTERN, type MessageButton, type MessageButtonEmoji } from './messageButtons';
import type { ResourceDeclaration } from './resourceDeclaration';

/** One reason a message resource cannot be posted as declared, and the part to fix. */
export interface MessageResourceProblem {
    /**
     * The part as the editor names it, numbered from one — `embed 2 footer`, `button 3` — or
     * `embed 2` for something in an embed with no part of its own. Absent for the message as
     * a whole.
     */
    readonly where?: string;
    readonly message: string;
}

/** Copy holding a `{{token}}`: a posted message has no run to fill one in. */
const TOKEN_IN_TEXT =
    "No tokens here — this message sits in its channel for everyone, so there's nobody to fill {{…}} in for, " +
    'and it would go out braces and all. Spell it out.';

/** A picture holding a `{{token}}`, for the same reason. */
const TOKEN_IN_PICTURE =
    "No tokens here — this message sits in its channel for everyone, so there's nobody to fill {{…}} in for. " +
    'Pick an upload or paste a link.';

/**
 * A button label holding a `{{token}}`. Nothing fills one in on any message: a journey's has
 * no run, and a block's buttons sit beside its `message` key, where the executor's copy walk
 * never looks. Worded for both, since both ask {@link messageButtonProblems}.
 */
const TOKEN_IN_BUTTON_LABEL = "No tokens here — a button's label goes out exactly as typed, braces and all. Spell it out.";

/** A button with nothing on its face: Discord refuses one, and with it the whole message. */
const NOTHING_TO_PRESS = 'A button needs a label or an emoji — something to press.';

/**
 * A button emoji that is not one: more than one glyph, a word, a server emoji's name Discord
 * would never give, or a standard emoji claiming to be animated.
 */
const NOT_AN_EMOJI = "That's not an emoji.";

/**
 * What is wrong with a button's emoji, or nothing: a server emoji's name is Discord's
 * `[A-Za-z0-9_]{2,32}`, a standard one's is one emoji (`isOneEmoji`), and only a server
 * emoji is animated. All keyed on whether it has an id, so the schema cannot say them.
 */
function emojiProblem(emoji: MessageButtonEmoji): string | undefined {
    if (emoji.id) return SERVER_EMOJI_NAME_PATTERN.test(emoji.name) ? undefined : NOT_AN_EMOJI;
    return isOneEmoji(emoji.name) && emoji.animated !== true ? undefined : NOT_AN_EMOJI;
}

/**
 * Where a problem at `path` sits, as the editor names it: the part itself when the path is
 * one of the message's parts, else the embed it is inside, else nowhere — the message as a
 * whole. The window places a sentence the same way (`placeMessageIssues`).
 *
 * The part names come from the one walk over a message (`messageCopyLocations` and
 * `messagePictures`), so a part is named here exactly as everywhere else.
 */
function whereIn(message: unknown, path: readonly PropertyKey[]): string | undefined {
    const joined = path.map(String).join('.');
    const part = [...messageCopyLocations(message), ...messagePictures(message)].find(
        (candidate) => candidate.path.join('.') === joined
    );
    if (part) return part.where;

    const [first, embed] = path;
    return first === 'embeds' && typeof embed === 'number' ? `embed ${embed + 1}` : undefined;
}

/**
 * Why a message resource cannot be posted as declared, in the order an author meets them,
 * or nothing when it can. Pure: the uploads, which need this server's, are judged apart
 * (`messageUploadProblems`).
 *
 *  1. **The message is one Discord takes**: `messageConfigSchema`, which holds every part's
 *     own rule, the rules spanning parts (`messageProblems`) and the picture and title-link
 *     forms — the rules a Post Embed node is saved under.
 *  2. **No `{{tokens}}` in the message**: not in its copy, not in a picture. A posted message
 *     has no member and no run, so nothing can fill one in — not even `{{guild.name}}`, which
 *     would need a second renderer outside flows and make every message drift when the
 *     server is renamed. Literal `{{…}}` text is refused with them.
 *  3. **Its buttons** ({@link messageButtonProblems}): something to press on each, no tokens
 *     in a label, and a key of their own — the rules a block's buttons are saved under too.
 *
 * A declaration with no `message` has nothing to judge: that it must carry one is the
 * structural rule `validateJourneyDeclaration` asks.
 */
export function messageResourceProblems(declaration: ResourceDeclaration): readonly MessageResourceProblem[] {
    const { message } = declaration;
    if (!message) return [];

    const problems: MessageResourceProblem[] = [];

    const parsed = messageConfigSchema.safeParse(message);
    if (!parsed.success) {
        for (const issue of parsed.error.issues) {
            const where = whereIn(message, issue.path);
            problems.push({ ...(where ? { where } : {}), message: issue.message });
        }
    }

    for (const location of messageCopyLocations(message)) {
        if (holdsCopyToken(location.value)) {
            problems.push({ where: location.where, message: location.checkRendered ? TOKEN_IN_PICTURE : TOKEN_IN_TEXT });
        }
    }

    for (const problem of messageButtonProblems(declaration.buttons ?? [])) {
        problems.push({ where: `button ${problem.index + 1}`, message: problem.message });
    }

    return problems;
}

/** One reason a button cannot go under a message, and which button, counted from zero. */
export interface MessageButtonProblem {
    readonly index: number;
    readonly message: string;
}

/**
 * Why buttons cannot go under a message as they stand, in the order an author meets them, or
 * nothing when they can — the rules spanning a button's fields or the list, which no schema
 * of a button's own fields can carry. The one rule set for every message with buttons: a
 * journey's message resource ({@link messageResourceProblems}) and a block's message
 * (`messageButtonsConfigSchema`) ask this, so the same buttons are refused with the same
 * sentences. Mirrored in the browser by `web/src/flows/messageResourceProblems.ts`.
 *
 *  1. **Each has something to press**: a label or an emoji, at least one, and an emoji that
 *     is one ({@link emojiProblem}).
 *  2. **No `{{tokens}}` in a label** ({@link TOKEN_IN_BUTTON_LABEL}).
 *  3. **Each key is its own**, since the key is what a press is routed by.
 */
export function messageButtonProblems(buttons: readonly MessageButton[]): readonly MessageButtonProblem[] {
    const problems: MessageButtonProblem[] = [];

    for (const [index, button] of buttons.entries()) {
        if (!button.label && !button.emoji) {
            problems.push({ index, message: NOTHING_TO_PRESS });
        }
        const emojiIssue = button.emoji && emojiProblem(button.emoji);
        if (emojiIssue) {
            problems.push({ index, message: emojiIssue });
        }
    }

    for (const [index, button] of buttons.entries()) {
        if (button.label && holdsCopyToken(button.label)) {
            problems.push({ index, message: TOKEN_IN_BUTTON_LABEL });
        }
    }

    const seenKeys = new Set<string>();
    for (const [index, button] of buttons.entries()) {
        if (seenKeys.has(button.key)) {
            problems.push({
                index,
                message: `Another button on this message already has the key "${button.key}". Give each its own — it's how a press finds its way.`,
            });
        }
        seenKeys.add(button.key);
    }

    return problems;
}

/**
 * One problem with a message resource as an operator reads it: `"Rules panel" embed 2
 * footer: …`, the resource's name in quotes, then the part. An upload problem
 * (`MessageUploadProblem`) has the same shape and is worded the same way.
 */
export function describeMessageResourceProblem(name: string, problem: MessageResourceProblem): string {
    return problem.where ? `"${name}" ${problem.where}: ${problem.message}` : `"${name}": ${problem.message}`;
}
