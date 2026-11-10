import SqliteDatabase from 'better-sqlite3';
import { CamelCasePlugin, Kysely, SqliteDialect } from 'kysely';
import { DB_TYPE } from '../../../../../environment';
import type { Database, DatabaseClient } from '../../../../../features-system/data-persistence/database';
import { up as createChatAgentSessions } from '../../../../../features-system/data-persistence/migrations/2026-11-09-Create_Chat_Agent_Sessions';
import { SqlDatePlugin } from '../../../../../features-system/data-persistence/plugins/sqlDatePlugin';
import { SqliteBindingPlugin } from '../../../../../features-system/data-persistence/plugins/sqliteBindingPlugin';
import { SqliteJsonPlugin } from '../../../../../features-system/data-persistence/plugins/sqliteJsonPlugin';

/**
 * An in-memory database holding only the chat agent's session tables, built by their own
 * migration's sqlite arm, with the production client's plugins for them in the same order.
 * The migration picks its arm from `DB_TYPE`, so anything but sqlite is refused.
 */
export async function chatSessionsTestDb(): Promise<DatabaseClient> {
    if (DB_TYPE !== 'sqlite') {
        throw new Error(`chatSessionsTestDb builds an in-memory SQLite database, but DB_TYPE is "${DB_TYPE}". Unset DB_TYPE (vitest.setup.ts defaults it to sqlite).`);
    }
    const db = new Kysely<Database>({
        dialect: new SqliteDialect({ database: new SqliteDatabase(':memory:') }),
        plugins: [
            new SqliteBindingPlugin<Database>({}),
            new SqliteJsonPlugin<Database>({ chat_agent_session_turns: ['messages', 'readerIds', 'visibleChannelIds', 'postIds'] }),
            new CamelCasePlugin(),
            new SqlDatePlugin<Database>({ chat_agent_sessions: ['startedAt', 'lastActiveAt'], chat_agent_session_turns: ['createdAt'] }),
        ],
    });
    await createChatAgentSessions(db as unknown as Kysely<any>);
    return db;
}
