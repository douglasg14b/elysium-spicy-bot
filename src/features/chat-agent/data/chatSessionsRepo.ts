import { randomUUID } from 'node:crypto';
import { modelMessageSchema, type ModelMessage } from 'ai';
import { z } from 'zod';
import type { Selectable } from 'kysely';
import { database, type DatabaseClient } from '../../../features-system/data-persistence/database';
import type { ChatAgentSessionsTable } from './chatSessionsSchema';

export type ChatSession = Selectable<ChatAgentSessionsTable>;

/** One of a session's turns as read back. */
export type SessionTurn = {
    readonly askerId: string;
    readonly questionId: string;
    readonly question: string;
    readonly answer: string;
    /** Undefined when what was stored no longer reads as model messages, or its readers do not: the turn is replayed as its text. */
    readonly messages: readonly ModelMessage[] | undefined;
    /** The model that wrote `messages`. */
    readonly model: string;
    readonly readerIds: readonly string[];
    readonly visibleChannelIds: readonly string[];
    readonly postIds: readonly string[];
    readonly createdAt: Date;
};

/** A turn as it is written. */
export type NewSessionTurn = Omit<SessionTurn, 'messages' | 'createdAt'> & { readonly messages: readonly ModelMessage[] };

export type RecordTurnInput = {
    /** The session it carries on, or null to start one. */
    readonly sessionId: string | null;
    readonly guildId: string;
    readonly channelId: string;
    readonly turn: NewSessionTurn;
    readonly now: Date;
    /** A session keeps at most this many turns, dropping its oldest. */
    readonly keepTurns: number;
};

const storedMessages = modelMessageSchema.array();
const storedIds = z.array(z.string());

/**
 * Text Postgres will store: a lone half of a surrogate pair (a tool cut through an emoji) is
 * refused by `jsonb`, and a NUL by `text` and `jsonb` both. SQLite stores either, so without
 * this one dialect would lose the turn.
 */
function storable(text: string): string {
    return text.toWellFormed().replaceAll('\u0000', '');
}

/** `value` as JSON whose every string is {@link storable}. */
function storableJson(value: unknown): string {
    return JSON.stringify(value, (_key, inner: unknown) => (typeof inner === 'string' ? storable(inner) : inner));
}

/** Persistence for the chat agent's sessions (`chatSessionsSchema.ts`). SQL lives here and nowhere else. */
export class ChatSessionsRepo {
    constructor(private readonly db: DatabaseClient = database) {}

    /** The session the bot's message `messageId` was posted in, scoped to the guild; undefined for any other message. */
    async findByPost(guildId: string, messageId: string): Promise<ChatSession | undefined> {
        return this.db
            .selectFrom('chat_agent_session_posts')
            .innerJoin('chat_agent_sessions', 'chat_agent_sessions.id', 'chat_agent_session_posts.sessionId')
            .selectAll('chat_agent_sessions')
            .where('chat_agent_session_posts.messageId', '=', messageId)
            .where('chat_agent_session_posts.guildId', '=', guildId)
            .executeTakeFirst();
    }

    /** The channel's most recently active session, if it has one. */
    async findLatestInChannel(guildId: string, channelId: string): Promise<ChatSession | undefined> {
        return this.db
            .selectFrom('chat_agent_sessions')
            .selectAll()
            .where('channelId', '=', channelId)
            .where('guildId', '=', guildId)
            .orderBy('lastActiveAt', 'desc')
            .limit(1)
            .executeTakeFirst();
    }

    /**
     * A session's turns, oldest first. A turn whose stored messages no longer read as model
     * messages — written by an older AI SDK, say — comes back without them, and so does one
     * whose readers do not read as ids, since they decide who may see its results; either is
     * logged, so one bad row costs its trace, not the conversation. Posts that do not read as
     * ids are none: the turn is shown as one from before the window. (So do the channels its
     * readers could see, which decide it too.)
     */
    async listTurns(sessionId: string): Promise<SessionTurn[]> {
        const rows = await this.db
            .selectFrom('chat_agent_session_turns')
            .select(['id', 'askerId', 'questionId', 'question', 'answer', 'messages', 'model', 'readerIds', 'visibleChannelIds', 'postIds', 'createdAt'])
            .where('sessionId', '=', sessionId)
            .orderBy('id', 'asc')
            .execute();
        return rows.map(({ id, messages, readerIds, visibleChannelIds, postIds, ...row }) => {
            const parsedMessages = storedMessages.safeParse(messages);
            const parsedReaders = storedIds.safeParse(readerIds);
            const parsedChannels = storedIds.safeParse(visibleChannelIds);
            const parsedPosts = storedIds.safeParse(postIds);
            const traced = parsedMessages.success && parsedReaders.success && parsedChannels.success;
            if (!traced || !parsedPosts.success) console.warn(`[chat-agent] session turn ${id} does not read back whole; replaying its text only`);
            return {
                ...row,
                messages: traced ? parsedMessages.data : undefined,
                readerIds: parsedReaders.success ? parsedReaders.data : [],
                visibleChannelIds: parsedChannels.success ? parsedChannels.data : [],
                postIds: parsedPosts.success ? parsedPosts.data : [],
            };
        });
    }

    /**
     * Records a turn and the messages it posted as, starting its session when `sessionId` is
     * null, and moves the session's activity to `now` and its last post to the turn's last.
     * A session swept while its turn ran is written again under the same id, so its turn is
     * never left under no session. Drops the session's turns past `keepTurns` (their posts
     * stay, so a reply to one still finds the session). Returns the session's id. Throws on a
     * turn that posted nothing: there is no message to carry the session on from.
     */
    async recordTurn(input: RecordTurnInput): Promise<string> {
        const { turn, now } = input;
        const lastPostId = turn.postIds.at(-1);
        if (!lastPostId) throw new Error('A chat agent turn is recorded only once it has posted');
        const at = now.toISOString();

        return this.db.transaction().execute(async (trx) => {
            const sessionId = input.sessionId ?? randomUUID();
            await trx
                .insertInto('chat_agent_sessions')
                .values({ id: sessionId, guildId: input.guildId, channelId: input.channelId, startedAt: at, lastActiveAt: at, lastPostId })
                .onConflict((conflict) => conflict.column('id').doUpdateSet({ lastActiveAt: at, lastPostId }))
                .execute();
            const { id: turnId } = await trx
                .insertInto('chat_agent_session_turns')
                .values({
                    sessionId,
                    askerId: turn.askerId,
                    questionId: turn.questionId,
                    question: storable(turn.question),
                    answer: storable(turn.answer),
                    // Serialised here: the sqlite JSON plugin only parses on the way out.
                    messages: storableJson(turn.messages),
                    model: turn.model,
                    readerIds: JSON.stringify(turn.readerIds),
                    visibleChannelIds: JSON.stringify(turn.visibleChannelIds),
                    postIds: JSON.stringify(turn.postIds),
                    createdAt: at,
                })
                .returning('id')
                .executeTakeFirstOrThrow();
            await trx
                .insertInto('chat_agent_session_posts')
                .values(turn.postIds.map((messageId) => ({ messageId, guildId: input.guildId, sessionId, turnId })))
                .execute();
            await trx
                .deleteFrom('chat_agent_session_turns')
                .where('sessionId', '=', sessionId)
                .where('id', 'not in', (query) =>
                    query
                        .selectFrom('chat_agent_session_turns')
                        .select('id')
                        .where('sessionId', '=', sessionId)
                        .orderBy('id', 'desc')
                        .limit(input.keepTurns)
                )
                .execute();
            return sessionId;
        });
    }

    /**
     * Deletes every session last active before `cutoff`, with its turns and posts — and any
     * turn or post left under no session at all, so nothing outlives the sweep.
     */
    async deleteInactiveSince(cutoff: Date): Promise<void> {
        await this.db.transaction().execute(async (trx) => {
            await trx.deleteFrom('chat_agent_sessions').where('lastActiveAt', '<', cutoff).execute();
            const live = trx.selectFrom('chat_agent_sessions').select('id');
            await trx.deleteFrom('chat_agent_session_posts').where('sessionId', 'not in', live).execute();
            await trx.deleteFrom('chat_agent_session_turns').where('sessionId', 'not in', live).execute();
        });
    }

    /**
     * Deletes the turns that answered, or posted, any of `messageIds` in this guild: a message
     * someone deleted is gone from the session too, not replayed to the model for a day. The
     * posts stay, so a reply to one of a split reply's other parts still finds the session.
     */
    async deleteTurnsTouching(guildId: string, messageIds: readonly string[]): Promise<void> {
        if (messageIds.length === 0) return;
        await this.db
            .deleteFrom('chat_agent_session_turns')
            .where((where) =>
                where.or([
                    where(
                        'id',
                        'in',
                        where.selectFrom('chat_agent_session_posts').select('turnId').where('guildId', '=', guildId).where('messageId', 'in', messageIds)
                    ),
                    where.and([
                        where('questionId', 'in', messageIds),
                        where('sessionId', 'in', where.selectFrom('chat_agent_sessions').select('chat_agent_sessions.id').where('chat_agent_sessions.guildId', '=', guildId)),
                    ]),
                ])
            )
            .execute();
    }
}

export const chatSessionsRepo = new ChatSessionsRepo();
