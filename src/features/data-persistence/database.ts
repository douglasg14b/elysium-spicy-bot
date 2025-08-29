import { FlashChatConfigTable } from '../flash-chat/data/flashChatSchema';

import SqliteDatabase from 'better-sqlite3';
import { Kysely, SqliteDialect, CamelCasePlugin } from 'kysely';
import { CommandAuditLogTable } from '../commands';
import { SqliteBooleanPlugin } from './plugins/sqliteBooleanPlugin';
import { SqliteJsonPlugin } from './plugins/sqliteJsonPlugin';

export interface Database {
    flash_chat_config: FlashChatConfigTable;
    command_audit_logs: CommandAuditLogTable;
}

const dialect = new SqliteDialect({
    database: async () =>
        new SqliteDatabase('db.sqlite', {
            fileMustExist: false,
        }),
});

export type DatabaseClient = Kysely<Database>;
export const database = new Kysely<Database>({
    dialect,
    plugins: [
        new CamelCasePlugin(),
        new SqliteBooleanPlugin<Database>({
            flash_chat_config: ['enabled', 'removed', 'preserveHistory', 'preservePinned'],
        }),
        // new SqliteJsonPlugin<Database>({
        //     command_audit_logs: ['parameters', 'resultData'],
        // }),
    ],
});
