import SqliteDatabase from 'better-sqlite3';
import { CamelCasePlugin, Kysely, SqliteDialect } from 'kysely';
import { DB_TYPE } from '../../../../../environment';
import type { Database, DatabaseClient } from '../../../../../features-system/data-persistence/database';
import { up as createChatAgentIntros } from '../../../../../features-system/data-persistence/migrations/2026-11-10-Create_Chat_Agent_Intros';
import { SqlDatePlugin } from '../../../../../features-system/data-persistence/plugins/sqlDatePlugin';

/**
 * An in-memory database holding only `chat_agent_intros`, built by its own migration's sqlite
 * arm, with the production client's plugins for it in the same order. As `chatSessionsTestDb`,
 * anything but sqlite is refused.
 */
export async function chatIntrosTestDb(): Promise<DatabaseClient> {
    if (DB_TYPE !== 'sqlite') {
        throw new Error(`chatIntrosTestDb builds an in-memory SQLite database, but DB_TYPE is "${DB_TYPE}". Unset DB_TYPE (vitest.setup.ts defaults it to sqlite).`);
    }
    const db = new Kysely<Database>({
        dialect: new SqliteDialect({ database: new SqliteDatabase(':memory:') }),
        plugins: [new CamelCasePlugin(), new SqlDatePlugin<Database>({ chat_agent_intros: ['postedAt'] })],
    });
    await createChatAgentIntros(db as unknown as Kysely<any>);
    return db;
}
