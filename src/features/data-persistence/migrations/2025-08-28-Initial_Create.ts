// 2025xxxx_create_command_audit_log.ts
import { Database } from 'better-sqlite3';
import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
    await commandAuditLog.up(db);
    await flashChat.up(db);
}

export async function down(db: Kysely<any>): Promise<void> {
    await commandAuditLog.down(db);
    await flashChat.down(db);
}

const flashChat = {
    up: async (db: Kysely<Database>) => {
        await db.schema
            .createTable('flash_chat_config')
            .addColumn('id', 'integer', (col) => col.primaryKey().autoIncrement())

            .addColumn('guild_id', 'text', (col) => col.notNull())
            .addColumn('channel_id', 'text', (col) => col.notNull())

            .addColumn('timeout_seconds', 'integer', (col) => col.notNull())

            .addColumn('preserve_pinned', 'integer', (col) => col.notNull().defaultTo(0))
            .addColumn('preserve_history', 'integer', (col) => col.notNull().defaultTo(0))

            .addColumn('enabled', 'integer', (col) => col.notNull().defaultTo(1))

            .addColumn('removed', 'integer', (col) => col.notNull().defaultTo(0))
            .addColumn('last_processed_at', 'text') // nullable ISO timestamp string

            .addColumn('created_by', 'text', (col) => col.notNull())
            .addColumn('created_by_name', 'text', (col) => col.notNull())
            .addColumn('updated_by', 'text', (col) => col.notNull())
            .addColumn('updated_by_name', 'text', (col) => col.notNull())
            .addColumn('created_at', 'text', (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
            .addColumn('updated_at', 'text', (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))

            .addColumn('config_version', 'integer', (col) => col.notNull().defaultTo(1))

            // Boolean guards (0/1)
            .addCheckConstraint('fcc_enabled_bool_check', sql`enabled in (0, 1)`)
            .addCheckConstraint('fcc_removed_bool_check', sql`removed in (0, 1)`)
            .addCheckConstraint('fcc_preserve_pinned_bool_check', sql`preserve_pinned in (0, 1)`)
            .addCheckConstraint('fcc_preserve_history_bool_check', sql`preserve_history in (0, 1)`)

            .execute();

        // Indexes per your comments + a common composite index for lookups
        await db.schema.createIndex('fcc_guild_id_idx').on('flash_chat_config').column('guild_id').execute();

        await db.schema.createIndex('fcc_channel_id_idx').on('flash_chat_config').column('channel_id').execute();

        await db.schema
            .createIndex('fcc_guild_channel_idx')
            .on('flash_chat_config')
            .columns(['guild_id', 'channel_id'])
            .execute();
    },
    down: async (db: Kysely<Database>) => {
        await db.schema.dropIndex('fcc_guild_channel_idx').ifExists().execute();
        await db.schema.dropIndex('fcc_channel_id_idx').ifExists().execute();
        await db.schema.dropIndex('fcc_guild_id_idx').ifExists().execute();
        await db.schema.dropTable('flash_chat_config').ifExists().execute();
    },
};

const commandAuditLog = {
    up: async (db: Kysely<Database>) => {
        // Table
        await db.schema
            .createTable('command_audit_logs')
            .addColumn('id', 'integer', (col) => col.primaryKey().autoIncrement())
            .addColumn('command', 'text', (col) => col.notNull())
            .addColumn('subcommand', 'text') // nullable
            .addColumn('channel_id', 'text', (col) => col.notNull())
            .addColumn('channelName', 'text', (col) => col.notNull())
            .addColumn('guild_id', 'text', (col) => col.notNull())
            .addColumn('guildName', 'text', (col) => col.notNull())
            .addColumn('user_id', 'text', (col) => col.notNull())
            .addColumn('user_name', 'text', (col) => col.notNull())
            .addColumn('user_discriminator', 'text') // nullable (new Discord usernames)
            // Store JSON as TEXT in SQLite; enforce validity with CHECK(json_valid(...))
            .addColumn('parameters', 'text', (col) => col.notNull().defaultTo(sql`'{}'`))
            .addColumn('result', 'text', (col) => col.notNull())
            .addColumn('result_message', 'text') // nullable
            .addColumn('result_data', 'text') // nullable JSON
            .addColumn('execution_time_ms', 'integer', (col) => col.notNull())
            // Store ISO-ish timestamp string; default to CURRENT_TIMESTAMP (UTC)
            .addColumn('timestamp', 'text', (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
            // Enum guard for `result`
            .addCheckConstraint('cal_result_check', sql`result in ('success','error','skipped')`)
            // JSON validity guards
            .addCheckConstraint('cal_parameters_json_check', sql`json_valid(parameters)`)
            .addCheckConstraint('cal_result_data_json_check', sql`result_data is null or json_valid(result_data)`)
            .execute();

        // Indexes
        await db.schema
            .createIndex('cal_guild_channel_ts_idx')
            .on('command_audit_logs')
            .columns(['guild_id', 'channel_id', 'timestamp'])
            .execute();

        await db.schema
            .createIndex('cal_user_ts_idx')
            .on('command_audit_logs')
            .columns(['user_id', 'timestamp'])
            .execute();

        await db.schema
            .createIndex('cal_command_ts_idx')
            .on('command_audit_logs')
            .columns(['command', 'timestamp'])
            .execute();
    },
    down: async (db: Kysely<Database>) => {
        await db.schema.dropIndex('cal_command_ts_idx').ifExists().execute();
        await db.schema.dropIndex('cal_user_ts_idx').ifExists().execute();
        await db.schema.dropIndex('cal_guild_channel_ts_idx').ifExists().execute();
        await db.schema.dropTable('command_audit_logs').ifExists().execute();
    },
};
