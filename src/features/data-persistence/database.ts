import { FlashChatConfigTable } from '../flash-chat/data/flashChatSchema';

import SqliteDatabase from 'better-sqlite3';
import pg from 'pg';
const { Pool } = pg;

import { Kysely, SqliteDialect, CamelCasePlugin, PostgresDialect } from 'kysely';
import { CommandAuditLogTable } from '../commands';
import { SqlBooleanPlugin } from './plugins/sqlBooleanPlugin';
import { SqliteJsonPlugin } from './plugins/sqliteJsonPlugin';
import { SqlDatePlugin } from './plugins/sqlDatePlugin';
import { DB_TYPE, PG_CONNECTION_STRING, SQLITE_DB_PATH } from '../../environment';

export interface Database {
    flash_chat_config: FlashChatConfigTable;
    command_audit_logs: CommandAuditLogTable;
}

function getDbDialect() {
    if (DB_TYPE === 'sqlite') {
        return new SqliteDialect({
            database: async () =>
                new SqliteDatabase(SQLITE_DB_PATH, {
                    fileMustExist: false,
                }),
        });
    } else if (DB_TYPE === 'postgres') {
        return new PostgresDialect({
            pool: new Pool({
                connectionString: PG_CONNECTION_STRING,
                max: 10,
            }),
        });
    }

    throw new Error(`Unsupported DB_TYPE: ${DB_TYPE}`);
}

function getDatabaseClient() {
    const dbDialect = getDbDialect();

    const plugins = [
        new SqlDatePlugin<Database>({
            flash_chat_config: ['createdAt', 'updatedAt'],
            command_audit_logs: ['timestamp'],
        }),
    ];

    if (DB_TYPE === 'sqlite') {
        return new Kysely<Database>({
            dialect: dbDialect,
            plugins: [
                new CamelCasePlugin(),
                new SqlBooleanPlugin<Database>({
                    flash_chat_config: ['enabled', 'removed', 'preserveHistory', 'preservePinned'],
                }),
                ...plugins,
            ],
        });
    } else if (DB_TYPE === 'postgres') {
        return new Kysely<Database>({
            dialect: dbDialect,
            plugins,
        });
    }

    throw new Error(`Unsupported DB_TYPE: ${DB_TYPE}`);
}

export type DatabaseClient = Kysely<Database>;
export const database = getDatabaseClient();
