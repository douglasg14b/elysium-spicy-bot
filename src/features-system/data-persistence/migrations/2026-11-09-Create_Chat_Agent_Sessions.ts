import { Kysely } from 'kysely';
import { DB_TYPE } from '../../../environment';

export async function up(db: Kysely<any>): Promise<void> {
    await migration[DB_TYPE].up(db);
}

export async function down(db: Kysely<any>): Promise<void> {
    await migration[DB_TYPE].down(db);
}

/**
 * Creates the chat agent's sessions (`chatSessionsSchema.ts`):
 *
 * - `chat_agent_sessions`, one per conversation in a channel; found by channel, newest
 *   activity first (`chat_agent_sessions_channel_idx`), and swept a day after its last
 *   activity (`chat_agent_sessions_last_active_idx`).
 * - `chat_agent_session_turns`, each reply's question (and its message's id, which a delete
 *   arrives naming — `chat_agent_session_turns_question_idx`), answer, model messages (JSON),
 *   the model that wrote them, its readers and the channels all of them could see (JSON),
 *   read by session in order.
 * - `chat_agent_session_posts`, every message the bot posted in one and the turn it posted
 *   for, keyed by its Discord id, which a reply to it — or its deletion — arrives naming.
 *
 * No foreign keys: the repo deletes a session's turns and posts with it, in one transaction.
 * Times have no default: the one writer always sets them.
 */
const migration = {
    postgres: {
        up: async (db: Kysely<any>) => {
            await db.schema
                .createTable('chat_agent_sessions')
                .addColumn('id', 'text', (col) => col.primaryKey())
                .addColumn('guild_id', 'text', (col) => col.notNull())
                .addColumn('channel_id', 'text', (col) => col.notNull())
                .addColumn('started_at', 'timestamptz', (col) => col.notNull())
                .addColumn('last_active_at', 'timestamptz', (col) => col.notNull())
                .addColumn('last_post_id', 'text', (col) => col.notNull())
                .execute();
            await db.schema
                .createTable('chat_agent_session_turns')
                .addColumn('id', 'serial', (col) => col.primaryKey())
                .addColumn('session_id', 'text', (col) => col.notNull())
                .addColumn('asker_id', 'text', (col) => col.notNull())
                .addColumn('question_id', 'text', (col) => col.notNull())
                .addColumn('question', 'text', (col) => col.notNull())
                .addColumn('answer', 'text', (col) => col.notNull())
                .addColumn('messages', 'jsonb', (col) => col.notNull())
                .addColumn('model', 'text', (col) => col.notNull())
                .addColumn('reader_ids', 'jsonb', (col) => col.notNull())
                .addColumn('visible_channel_ids', 'jsonb', (col) => col.notNull())
                .addColumn('post_ids', 'jsonb', (col) => col.notNull())
                .addColumn('created_at', 'timestamptz', (col) => col.notNull())
                .execute();
            await db.schema
                .createTable('chat_agent_session_posts')
                .addColumn('message_id', 'text', (col) => col.primaryKey())
                .addColumn('guild_id', 'text', (col) => col.notNull())
                .addColumn('session_id', 'text', (col) => col.notNull())
                .addColumn('turn_id', 'integer', (col) => col.notNull())
                .execute();
            await createIndexes(db);
        },
        down: dropTables,
    },
    sqlite: {
        up: async (db: Kysely<any>) => {
            // Times as ISO-8601 with an explicit `Z`: the repo writes `toISOString()`.
            await db.schema
                .createTable('chat_agent_sessions')
                .addColumn('id', 'text', (col) => col.primaryKey())
                .addColumn('guild_id', 'text', (col) => col.notNull())
                .addColumn('channel_id', 'text', (col) => col.notNull())
                .addColumn('started_at', 'text', (col) => col.notNull())
                .addColumn('last_active_at', 'text', (col) => col.notNull())
                .addColumn('last_post_id', 'text', (col) => col.notNull())
                .execute();
            await db.schema
                .createTable('chat_agent_session_turns')
                .addColumn('id', 'integer', (col) => col.primaryKey().autoIncrement())
                .addColumn('session_id', 'text', (col) => col.notNull())
                .addColumn('asker_id', 'text', (col) => col.notNull())
                .addColumn('question_id', 'text', (col) => col.notNull())
                .addColumn('question', 'text', (col) => col.notNull())
                .addColumn('answer', 'text', (col) => col.notNull())
                .addColumn('messages', 'text', (col) => col.notNull())
                .addColumn('model', 'text', (col) => col.notNull())
                .addColumn('reader_ids', 'text', (col) => col.notNull())
                .addColumn('visible_channel_ids', 'text', (col) => col.notNull())
                .addColumn('post_ids', 'text', (col) => col.notNull())
                .addColumn('created_at', 'text', (col) => col.notNull())
                .execute();
            await db.schema
                .createTable('chat_agent_session_posts')
                .addColumn('message_id', 'text', (col) => col.primaryKey())
                .addColumn('guild_id', 'text', (col) => col.notNull())
                .addColumn('session_id', 'text', (col) => col.notNull())
                .addColumn('turn_id', 'integer', (col) => col.notNull())
                .execute();
            await createIndexes(db);
        },
        down: dropTables,
    },
};

async function createIndexes(db: Kysely<any>): Promise<void> {
    await db.schema.createIndex('chat_agent_sessions_channel_idx').on('chat_agent_sessions').columns(['channel_id', 'last_active_at']).execute();
    await db.schema.createIndex('chat_agent_sessions_last_active_idx').on('chat_agent_sessions').column('last_active_at').execute();
    await db.schema.createIndex('chat_agent_session_turns_session_idx').on('chat_agent_session_turns').columns(['session_id', 'id']).execute();
    await db.schema.createIndex('chat_agent_session_turns_question_idx').on('chat_agent_session_turns').column('question_id').execute();
    await db.schema.createIndex('chat_agent_session_posts_session_idx').on('chat_agent_session_posts').column('session_id').execute();
}

async function dropTables(db: Kysely<any>): Promise<void> {
    await db.schema.dropTable('chat_agent_session_posts').ifExists().execute();
    await db.schema.dropTable('chat_agent_session_turns').ifExists().execute();
    await db.schema.dropTable('chat_agent_sessions').ifExists().execute();
}
