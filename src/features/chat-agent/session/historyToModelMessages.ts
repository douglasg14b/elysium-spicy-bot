import type { ModelMessage } from 'ai';
import { fitTrace } from './fitTrace';
import { sizeOf } from './traceNotes';

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

/**
 * What a session holds about one of the bot's messages in the window: the trace of the turn it
 * posted — tool calls, results and text — or that it is a later part of a split reply whose
 * trace sits on an earlier part (`of`), whose text it joins when the trace cannot be shown.
 * `question` is what the turn answered (`questionId`), shown before its trace whenever the
 * message it was asked in has been trimmed away.
 */
export type SessionPost =
    | { readonly kind: 'traced'; readonly trace: readonly ModelMessage[]; readonly question: string; readonly questionId: string }
    | { readonly kind: 'continuation'; readonly of: string };

/** A turn of the session whose posts are older than the window: what was asked, what the bot said, and its trace when it may be shown. */
export type EarlierTurn = {
    readonly question: string;
    readonly answer: string;
    readonly trace: readonly ModelMessage[] | undefined;
};

/** What the session adds to the channel's history (`sessionReplay.ts` decides it). */
export type SessionMemory = {
    readonly postFor: (messageId: string) => SessionPost | undefined;
    /** Oldest first. */
    readonly earlier: readonly EarlierTurn[];
};

/** No session: the history alone. */
export const NO_SESSION: SessionMemory = { postFor: () => undefined, earlier: [] };

/** Characters of history, newest kept first: the people's messages and the bot's plain replies. */
const CHAT_CHARACTER_BUDGET = 16_000;

/** Characters of session traces, spent apart from the chat's, so what the bot looked up outlives the chatter around it. */
const TRACE_CHARACTER_BUDGET = 60_000;

type HistoryBudgets = { readonly chat: number; readonly traces: number };

const DEFAULT_BUDGETS: HistoryBudgets = { chat: CHAT_CHARACTER_BUDGET, traces: TRACE_CHARACTER_BUDGET };

/** Marks the user line being answered, which the instructions tell the model to look for. */
export const ANSWERING_MARK = '→ ';

/**
 * The channel's history as model messages, oldest first, with the session's memory in it.
 *
 * Discord is the source of truth for what people said. A session adds only what Discord
 * cannot hold — what the bot looked up on its way to each reply — so a bot message the
 * session traced is replaced by that trace (a split reply's later parts with it), and the
 * session's turns older than the window come first, as their question and trace. Anything
 * else from the bot (another session's, or one whose trace may not be shown) is a plain
 * assistant turn with its text.
 *
 * Trimmed from the oldest end, against two budgets: traces spend `budgets.traces`, everything
 * else `budgets.chat`. The message being answered and everything after it always stay, and a
 * turn is kept or dropped whole, so a tool result is never separated from its call. A trace
 * too big for what is left loses its largest results to a note (`fitTrace`), then falls back
 * to its plain text, so one long lookup does not cost the conversation before it. Once the
 * chat budget is spent, older chat is dropped but older traces still come in while their
 * budget lasts — what the bot looked up outlives the chatter — and any trace whose question
 * did not make it in is led by it.
 */
export function historyToModelMessages(
    history: readonly HistoryMessage[],
    memory: SessionMemory = NO_SESSION,
    budgets: HistoryBudgets = DEFAULT_BUDGETS
): ModelMessage[] {
    const entries: Entry[] = memory.earlier.map((turn) => {
        const question: ModelMessage = { role: 'user', content: turn.question };
        return {
            messageId: undefined,
            traced: turn.trace ? [question, ...turn.trace] : undefined,
            question: undefined,
            plain: [question, { role: 'assistant', content: turn.answer }],
            isBeingAnswered: false,
        };
    });
    const tracedPosts = new Map<string, Entry>();
    for (const message of history) {
        const post = message.isFromThisBot ? memory.postFor(message.id) : undefined;
        if (post?.kind === 'continuation') {
            const first = tracedPosts.get(post.of);
            if (first) {
                first.plain = [{ role: 'assistant', content: `${plainText(first.plain)}\n${message.content}` }];
                continue;
            }
        }
        const entry: Entry = {
            messageId: message.id,
            traced: post?.kind === 'traced' ? [...post.trace] : undefined,
            question: post?.kind === 'traced' ? { id: post.questionId, text: post.question } : undefined,
            plain: toPlainTurn(message),
            isBeingAnswered: message.isBeingAnswered,
        };
        if (entry.traced) tracedPosts.set(message.id, entry);
        entries.push(entry);
    }

    const answeredIndex = entries.findLastIndex((entry) => entry.isBeingAnswered);
    const firstKept = answeredIndex === -1 ? entries.length : answeredIndex;
    const spent = { chat: 0, traces: 0 };
    const kept: Kept[] = entries.slice(firstKept).map((entry) => {
        const form = entry.traced ?? entry.plain;
        spent[entry.traced ? 'traces' : 'chat'] += sizeOf(form);
        return { entry, form, traced: !!entry.traced };
    });
    let chatFull = false;
    for (let index = firstKept - 1; index >= 0; index--) {
        const entry = entries[index];
        const traced = entry.traced && fitTrace(entry.traced, budgets.traces - spent.traces);
        if (traced) {
            kept.unshift({ entry, form: traced, traced: true });
            spent.traces += sizeOf(traced);
            continue;
        }
        if (chatFull) continue;
        if (spent.chat + sizeOf(entry.plain) > budgets.chat) {
            chatFull = true;
            continue;
        }
        kept.unshift({ entry, form: entry.plain, traced: false });
        spent.chat += sizeOf(entry.plain);
    }
    const keptIds = new Set(kept.map(({ entry }) => entry.messageId));
    const forms = kept.map(({ entry, form, traced }) =>
        traced && entry.question && !keptIds.has(entry.question.id) ? [{ role: 'user', content: entry.question.text } satisfies ModelMessage, ...form] : form
    );
    return dropLeadingNonUserTurns(forms).flat();
}

/** An entry as it made the cut, in the form it did. */
type Kept = { readonly entry: Entry; readonly form: ModelMessage[]; readonly traced: boolean };

/**
 * One turn of the conversation, in the forms it may be shown in: its trace when it has one,
 * its text always. `messageId` is the history message it is (none for an earlier turn);
 * `question` leads a trace from the window whose question was trimmed away — an earlier
 * turn's trace already starts with its own.
 */
type Entry = {
    readonly messageId: string | undefined;
    readonly traced: ModelMessage[] | undefined;
    readonly question: { readonly id: string; readonly text: string } | undefined;
    plain: ModelMessage[];
    readonly isBeingAnswered: boolean;
};

/** The text of a plain assistant turn. */
function plainText(turn: readonly ModelMessage[]): string {
    const [message] = turn;
    return typeof message?.content === 'string' ? message.content : '';
}

/** The message as its text alone: the bot's as an assistant turn, anyone else's as a user line. */
function toPlainTurn(message: HistoryMessage): ModelMessage[] {
    return message.isFromThisBot ? [{ role: 'assistant', content: message.content }] : [{ role: 'user', content: formatUserLine(message) }];
}

/** `→ [2026-11-06 21:04] Vex (replying to Mara): text` — who and when, since every user turn shares one role. */
function formatUserLine(message: HistoryMessage): string {
    return `${message.isBeingAnswered ? ANSWERING_MARK : ''}${formatQuestion(message)}`;
}

/** A message as a user line, unmarked: how a session keeps the question a turn answered. */
export function formatQuestion(message: HistoryMessage): string {
    const when = message.createdAt.toISOString().slice(0, 16).replace('T', ' ');
    const who = message.isFromOtherBot ? `${message.authorName} [bot]` : message.authorName;
    const replying = message.replyToAuthorName ? ` (replying to ${message.replyToAuthorName})` : '';
    return `[${when}] ${who}${replying}: ${message.content}`;
}

/** History cut mid-conversation must still open on a user turn, which every provider accepts. */
function dropLeadingNonUserTurns(turns: ModelMessage[][]): ModelMessage[][] {
    const firstUser = turns.findIndex((turn) => turn[0]?.role === 'user');
    return firstUser === -1 ? [] : turns.slice(firstUser);
}
