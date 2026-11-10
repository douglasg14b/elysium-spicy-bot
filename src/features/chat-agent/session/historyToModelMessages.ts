import type { ModelMessage } from 'ai';

/** One Discord message as the agent's history sees it — plain data, no discord.js. */
export type HistoryMessage = {
    readonly id: string;
    readonly authorName: string;
    /** Written by this bot: becomes an assistant turn rather than a user line. */
    readonly isFromThisBot: boolean;
    /** Written by some other bot or app. */
    readonly isFromOtherBot: boolean;
    readonly content: string;
    readonly createdAt: Date;
    readonly replyToAuthorName: string | undefined;
    /** The message this turn answers. Marked for the model, and never trimmed away. */
    readonly isBeingAnswered: boolean;
};

/** The model messages behind one of the bot's replies, and whose view of the server produced them. */
export type TracedTurn = {
    /** Who the reply answered. Tool results were read with their permissions. */
    readonly askerId: string;
    readonly messages: readonly ModelMessage[];
};

/**
 * What a session remembers about one of the bot's own messages: the turn that produced it,
 * or that it is the second part of a split reply whose trace sits on the first.
 */
export type TurnTrace = TracedTurn | 'continuation';

export type TraceLookup = (messageId: string) => TurnTrace | undefined;

/** Roughly how much history goes to the model, in characters, newest kept first. */
const HISTORY_CHARACTER_BUDGET = 16_000;

/** Marks the user line being answered, which the instructions tell the model to look for. */
export const ANSWERING_MARK = '→ ';

/**
 * The channel's history as model messages, oldest first.
 *
 * Discord is the source of truth for what people said. A session adds only what Discord
 * cannot hold — what the bot looked up on its way to each reply — so a bot message the
 * session traced is replaced by that trace, and one it did not (older, from before a
 * restart, or **answered for someone else**) becomes a plain assistant turn with its text.
 * Tool results are read with the asker's permissions, so one member's trace is never shown
 * to the model while it answers another.
 *
 * Trimmed from the oldest end to the character budget; the message being answered and
 * everything after it always stay, and a turn is kept or dropped whole, so a tool result
 * is never separated from its call. A traced turn too big to fit is kept as its plain text
 * instead, so one long lookup does not cost the conversation before it.
 */
export function historyToModelMessages(
    history: readonly HistoryMessage[],
    traceFor: TraceLookup,
    askerId: string,
    characterBudget: number = HISTORY_CHARACTER_BUDGET
): ModelMessage[] {
    const turns: { turn: ModelMessage[]; plain: ModelMessage[]; isBeingAnswered: boolean }[] = [];
    for (const message of history) {
        const turn = toTurn(message, traceFor, askerId);
        if (turn) turns.push({ turn, plain: toPlainTurn(message), isBeingAnswered: message.isBeingAnswered });
    }

    const answeredIndex = turns.findLastIndex((entry) => entry.isBeingAnswered);
    const firstKept = answeredIndex === -1 ? turns.length : answeredIndex;
    const kept = turns.slice(firstKept).map((entry) => entry.turn);
    let used = kept.reduce((total, turn) => total + JSON.stringify(turn).length, 0);
    for (let index = firstKept - 1; index >= 0; index--) {
        const fitting = [turns[index].turn, turns[index].plain].find((form) => used + JSON.stringify(form).length <= characterBudget);
        if (!fitting) break;
        kept.unshift(fitting);
        used += JSON.stringify(fitting).length;
    }
    return dropLeadingNonUserTurns(kept).flat();
}

function toTurn(message: HistoryMessage, traceFor: TraceLookup, askerId: string): ModelMessage[] | undefined {
    if (message.isFromThisBot) {
        const trace = traceFor(message.id);
        if (trace === 'continuation') return undefined;
        if (trace && trace.askerId === askerId) return [...trace.messages];
    }
    return toPlainTurn(message);
}

/** The message as its text alone: the bot's as an assistant turn, anyone else's as a user line. */
function toPlainTurn(message: HistoryMessage): ModelMessage[] {
    return message.isFromThisBot ? [{ role: 'assistant', content: message.content }] : [{ role: 'user', content: formatUserLine(message) }];
}

/** `→ [2026-11-06 21:04] Vex (replying to Mara): text` — who and when, since every user turn shares one role. */
function formatUserLine(message: HistoryMessage): string {
    const when = message.createdAt.toISOString().slice(0, 16).replace('T', ' ');
    const who = message.isFromOtherBot ? `${message.authorName} [bot]` : message.authorName;
    const replying = message.replyToAuthorName ? ` (replying to ${message.replyToAuthorName})` : '';
    const mark = message.isBeingAnswered ? ANSWERING_MARK : '';
    return `${mark}[${when}] ${who}${replying}: ${message.content}`;
}

/** History cut mid-conversation must still open on a user turn, which every provider accepts. */
function dropLeadingNonUserTurns(turns: ModelMessage[][]): ModelMessage[][] {
    const firstUser = turns.findIndex((turn) => turn[0]?.role === 'user');
    return firstUser === -1 ? [] : turns.slice(firstUser);
}
