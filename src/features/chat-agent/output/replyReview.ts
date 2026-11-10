import type { Viewers } from '../tools/visibleChannels';
import { linkReferences } from './linkReferences';
import { toReplyParts } from './replyText';

/** What a reply was turned back for. Each is something a model was seen doing in the evals. */
export type ReplyProblem =
    | { readonly kind: 'empty' }
    | { readonly kind: 'toolCallAsText' }
    | { readonly kind: 'petName'; readonly word: string }
    | { readonly kind: 'unknownChannel'; readonly names: readonly string[] };

/** What to do with a reply on its first try: post it, say nothing, or have the model try once more. */
export type FirstReview = PostReview | QuietReview | { readonly verdict: 'redo'; readonly problems: readonly ReplyProblem[] };

/** On the second try there is no third: post it, say nothing, or post the fallback line instead (silence in a ticket). */
export type LastReview = PostReview | QuietReview | { readonly verdict: 'fallback'; readonly problems: readonly ReplyProblem[] };

type PostReview = {
    readonly verdict: 'post';
    /** The reply as fixed, before links — what the model said, cleaned. */
    readonly text: string;
    /** What gets posted: linked and split, never empty. */
    readonly parts: readonly [string, ...string[]];
};
type QuietReview = { readonly verdict: 'quiet' };

/** Where the reply will land, for the checks that depend on it. */
export type ReviewContext = {
    readonly viewers: Viewers;
    readonly inTicket: boolean;
    /** The bot's display name, as the conversation shows it — what a copied chat-log line starts with. */
    readonly botName: string;
    /** The agent's tool names, which a model writing a tool call out as text names. */
    readonly toolNames: readonly string[];
};

/** At most this many emoji survive in a reply; the rest are removed. */
export const MAX_REPLY_EMOJI = 2;

/**
 * The output controls between the model and Discord. First what can be fixed in code is
 * fixed — a copied chat-log prefix (`[time] BrattyBot:`, `→`) stripped, a reply wrapped
 * whole in quotation marks unwrapped, emoji past {@link MAX_REPLY_EMOJI} removed — then what
 * cannot is checked:
 *
 * - **empty** — nothing left to post. In a ticket that is silence, as it always was.
 * - **toolCallAsText** — a tool call written out (`[{"name": …}]`, `stayQuiet`, "Stay quiet.").
 *   In a ticket the model was choosing silence, so it gets silence.
 * - **petName** — "darling", "honey" and the like, used to address someone.
 * - **unknownChannel** — a `#name` that is no channel everyone here can see.
 *
 * On the `'first'` try a problem asks for a redo; on the `'last'`, a made-up channel is posted
 * without its `#`, and anything else is a fallback.
 */
export function reviewReply(text: string, context: ReviewContext, attempt: 'first'): FirstReview;
export function reviewReply(text: string, context: ReviewContext, attempt: 'last'): LastReview;
export function reviewReply(text: string, context: ReviewContext, attempt: 'first' | 'last'): FirstReview | LastReview {
    const fixed = trimEmoji(unwrapQuotes(stripTranscriptEcho(text, context.botName)));

    if (toReplyParts(fixed).length === 0) {
        if (context.inTicket) return { verdict: 'quiet' };
        return turnBack([{ kind: 'empty' }], attempt);
    }
    if (isToolCallAsText(fixed, context.toolNames)) {
        if (context.inTicket) return { verdict: 'quiet' };
        return turnBack([{ kind: 'toolCallAsText' }], attempt);
    }

    const problems: ReplyProblem[] = [];
    const petName = PET_NAME.exec(fixed)?.[1];
    if (petName) problems.push({ kind: 'petName', word: petName.toLowerCase() });
    const linked = linkReferences(fixed, context.viewers, attempt === 'last' ? 'unmark' : 'keep');
    if (attempt === 'first' && linked.unknownChannels.length > 0) problems.push({ kind: 'unknownChannel', names: linked.unknownChannels });
    if (problems.length > 0) return turnBack(problems, attempt);

    const [first, ...rest] = toReplyParts(linked.text);
    // Linking only adds characters, so a reply with text keeps some; this is the type's proof.
    if (first === undefined) return turnBack([{ kind: 'empty' }], attempt);
    return { verdict: 'post', text: fixed, parts: [first, ...rest] };
}

function turnBack(problems: readonly ReplyProblem[], attempt: 'first' | 'last'): FirstReview | LastReview {
    return attempt === 'first' ? { verdict: 'redo', problems } : { verdict: 'fallback', problems };
}

/**
 * What the model is told when its reply is turned back, so the second try fixes that and
 * nothing else. Sent as a user message after its own reply.
 */
export function redoInstruction(problems: readonly ReplyProblem[]): string {
    const reasons = problems.map((problem) => {
        switch (problem.kind) {
            case 'empty':
                return 'it was empty — answer the message';
            case 'toolCallAsText':
                return 'it wrote a tool call out as text — call the tool properly, or just answer in words';
            case 'petName':
                return `it called them "${problem.word}" — no pet names`;
            case 'unknownChannel':
                return `${problem.names.map((name) => `#${name}`).join(', ')} ${problem.names.length === 1 ? 'is' : 'are'} not a channel here — name only channels your tools returned, or none`;
        }
    });
    return `[Not posted: ${reasons.join('; ')}. Write your reply to the same message again, fixing only that. Nobody saw the first one.]`;
}

/**
 * The conversation's own format, copied at the very start: `→ [Sat 23:40] BrattyBot: ` — a
 * line naming the bot, with or without the time and the answering mark — or a bare `→ `.
 * A reply that merely opens with something in brackets is left alone.
 */
function stripTranscriptEcho(text: string, botName: string): string {
    const name = botName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const line = new RegExp(`^\\s*(?:→\\s*)?(?:\\[[^\\]\\n]{1,40}\\]\\s*)?${name}\\s*:\\s*`, 'i');
    return text.replace(line, '').replace(/^\s*→\s*/, '');
}

const QUOTE_PAIRS: readonly (readonly [string, string])[] = [
    ['"', '"'],
    ['“', '”'],
];

/** A reply that is one quotation from end to end, with no quotation marks inside, without them. */
function unwrapQuotes(text: string): string {
    const trimmed = text.trim();
    for (const [open, close] of QUOTE_PAIRS) {
        if (trimmed.length < 2 || !trimmed.startsWith(open) || !trimmed.endsWith(close)) continue;
        const inside = trimmed.slice(open.length, -close.length);
        if (!/["“”]/.test(inside)) return inside.trim();
    }
    return text;
}

const EMOJI = /\p{Extended_Pictographic}/u;
const GRAPHEMES = new Intl.Segmenter('en', { granularity: 'grapheme' });

/** The reply with every emoji past the first {@link MAX_REPLY_EMOJI} removed, whole (skin tones and joined emoji are one). */
function trimEmoji(text: string): string {
    let seen = 0;
    let result = '';
    for (const { segment } of GRAPHEMES.segment(text)) {
        if (EMOJI.test(segment) && ++seen > MAX_REPLY_EMOJI) continue;
        result += segment;
    }
    return seen > MAX_REPLY_EMOJI ? result.replace(/ {2,}/g, ' ').replace(/ +([.,!?])/g, '$1') : text;
}

/** A tool call written out instead of made: JSON, a tool's name called like a function, or stayQuiet in words. */
function isToolCallAsText(text: string, toolNames: readonly string[]): boolean {
    if (/^\s*\[?\s*\{\s*"(?:name|tool|function)"\s*:/.test(text)) return true;
    if (/^\s*stay quiet\b/i.test(text)) return true;
    // No reply has reason to name a tool (`getServerRules`, `stayQuiet`) except by writing its call out.
    return toolNames.some((name) => new RegExp(`\\b${name}\\b`).test(text));
}

/**
 * A pet name used to address someone: at the start, after punctuation, or after a word like
 * "oh", and followed by punctuation or the end — "Oh, *darling*, I'm…", "since day one,
 * sweetheart." — not "honey badger" or "kitten play", which are about something.
 */
const PET_NAME =
    /(?:^|[,;:!?.…—–-]\s*|\b(?:oh|hey|look|listen|ok|okay|sure|fine|no|yes|nope|sorry|thanks)\s+)[*_]*(darling|honey|sweetheart|sweetie|kitten|babe|sugar)[*_]*(?=\s*(?:[,;:!?.…—–-]|$))/i;
