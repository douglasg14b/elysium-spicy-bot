import { Kysely } from 'kysely';
import { DB_TYPE } from '../../../environment';

export async function up(db: Kysely<any>): Promise<void> {
    await migration[DB_TYPE].up(db);
}

export async function down(db: Kysely<any>): Promise<void> {
    await migration[DB_TYPE].down(db);
}

/**
 * Creates `chat_agent_intros` (`chatIntrosSchema.ts`): the chat agent's copy of each server's
 * intros channel, one row per post, keyed by its Discord id (which an edit or delete arrives
 * naming), and read by member (`chat_agent_intros_author_idx`). No data to move: the copy fills
 * itself from the channel at startup.
 */
const migration = {
    postgres: {
        up: async (db: Kysely<any>) => {
            await db.schema
                .createTable('chat_agent_intros')
                .addColumn('message_id', 'text', (col) => col.primaryKey())
                .addColumn('guild_id', 'text', (col) => col.notNull())
                .addColumn('channel_id', 'text', (col) => col.notNull())
                .addColumn('author_id', 'text', (col) => col.notNull())
                .addColumn('content', 'text', (col) => col.notNull())
                .addColumn('posted_at', 'timestamptz', (col) => col.notNull())
                .execute();
            await createIndexes(db);
        },
        down: dropTable,
    },
    sqlite: {
        up: async (db: Kysely<any>) => {
            // Times as ISO-8601 with an explicit `Z`: the repo writes `toISOString()`.
            await db.schema
                .createTable('chat_agent_intros')
                .addColumn('message_id', 'text', (col) => col.primaryKey())
                .addColumn('guild_id', 'text', (col) => col.notNull())
                .addColumn('channel_id', 'text', (col) => col.notNull())
                .addColumn('author_id', 'text', (col) => col.notNull())
                .addColumn('content', 'text', (col) => col.notNull())
                .addColumn('posted_at', 'text', (col) => col.notNull())
                .execute();
            await createIndexes(db);
        },
        down: dropTable,
    },
};

async function createIndexes(db: Kysely<any>): Promise<void> {
    await db.schema.createIndex('chat_agent_intros_author_idx').on('chat_agent_intros').columns(['guild_id', 'author_id', 'posted_at']).execute();
    await db.schema.createIndex('chat_agent_intros_channel_idx').on('chat_agent_intros').columns(['guild_id', 'channel_id']).execute();
}

async function dropTable(db: Kysely<any>): Promise<void> {
    await db.schema.dropTable('chat_agent_intros').ifExists().execute();
}
