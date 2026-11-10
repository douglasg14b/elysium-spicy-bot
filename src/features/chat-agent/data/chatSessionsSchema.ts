import type { ModelMessage } from 'ai';
import type { ColumnType, Generated, JSONColumnType } from 'kysely';

/**
 * One conversation with the bot in one channel: started by a mention, carried on by every
 * mention after it while it is live, and by a reply to any of its posts for a day after
 * (`session/chatSessions.ts` decides which). Shared by everyone in the channel.
 *
 * Kept so the agent can reuse what it looked up: each turn's tool calls and results
 * (`chat_agent_session_turns`). What people said stays in Discord and is re-read every turn.
 * Deleted, with its turns and posts, a day after it was last active.
 */
export interface ChatAgentSessionsTable {
    id: string;
    guildId: string;
    channelId: string;
    startedAt: ColumnType<Date, string, string>;
    /** When its newest turn posted. Liveness and the day's revival are both counted from here. */
    lastActiveAt: ColumnType<Date, string, string>;
    /** The bot's newest message in it: the activity since then is counted from this message. */
    lastPostId: string;
}

/**
 * One of the bot's replies in a session: what was asked, what it looked up on the way,
 * what it answered, and who could read it then.
 */
export interface ChatAgentSessionTurnsTable {
    id: Generated<number>;
    sessionId: string;
    /** Who asked. Kept for reading a session back by hand; the replay itself does not ask. */
    askerId: string;
    /** The Discord message answered: deleting it deletes the turn (`initChatAgent`). */
    questionId: string;
    /** The message answered, as the model read it: `[2026-11-06 21:04] Vex: text`. */
    question: string;
    /** The reply's text, every part that posted. */
    answer: string;
    /** The model messages behind the reply — tool calls, results and text — as the AI SDK gave them. */
    messages: JSONColumnType<readonly ModelMessage[]>;
    /** The OpenRouter model that wrote them. Shown again only to the same model: another may refuse their ids and fields. */
    model: string;
    /** Everyone who could read the reply. Its tool results are shown again only while every reader was one of them. */
    readerIds: JSONColumnType<readonly string[]>;
    /** Every channel all of them could see then (`listVisibleChannels`): its results are shown again only while they all still can. */
    visibleChannelIds: JSONColumnType<readonly string[]>;
    /** The Discord messages it posted as, in order. */
    postIds: JSONColumnType<readonly string[]>;
    createdAt: ColumnType<Date, string, string>;
}

/** Every message the bot posted in a session, so a reply to one finds its session — and deleting one deletes its turn. */
export interface ChatAgentSessionPostsTable {
    messageId: string;
    guildId: string;
    sessionId: string;
    /** The turn it posted for; that turn may since have been dropped past a session's newest 20. */
    turnId: number;
}
