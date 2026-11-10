import { Kysely, sql } from 'kysely';
import { DB_TYPE } from '../../../environment';

export async function up(db: Kysely<any>): Promise<void> {
    await migration[DB_TYPE].up(db);
}

export async function down(db: Kysely<any>): Promise<void> {
    await migration[DB_TYPE].down(db);
}

/**
 * Creates `chat_agent_config`: one row per guild, its `config` a JSON blob
 * `{ contextChannels: { channelId, isRules }[], serverNotes, botRules }`. No row means nothing
 * configured.
 *
 * The unique index on `guild_id` is what makes this one-row-per-guild, and what the
 * repo's upsert conflicts on.
 */
const migration = {
    postgres: {
        up: async (db: Kysely<any>) => {
            await db.schema
                .createTable('chat_agent_config')
                .addColumn('id', 'serial', (col) => col.primaryKey())
                .addColumn('guild_id', 'text', (col) => col.notNull())
                .addColumn('config', 'jsonb', (col) => col.notNull())
                .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
                .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
                .addColumn('config_version', 'integer', (col) => col.notNull().defaultTo(1))
                .execute();

            await db.schema
                .createIndex('chat_agent_config_guild_unique_idx')
                .on('chat_agent_config')
                .column('guild_id')
                .unique()
                .execute();
        },
        down: async (db: Kysely<any>) => {
            await db.schema.dropTable('chat_agent_config').ifExists().execute();
        },
    },
    sqlite: {
        up: async (db: Kysely<any>) => {
            await db.schema
                .createTable('chat_agent_config')
                .addColumn('id', 'integer', (col) => col.primaryKey().autoIncrement())
                .addColumn('guild_id', 'text', (col) => col.notNull())
                .addColumn('config', 'text', (col) => col.notNull())
                // ISO-8601 with an explicit `Z`, as `guild_settings` does: the repo writes `toISOString()`.
                .addColumn('created_at', 'text', (col) =>
                    col.notNull().defaultTo(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`)
                )
                .addColumn('updated_at', 'text', (col) =>
                    col.notNull().defaultTo(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`)
                )
                .addColumn('config_version', 'integer', (col) => col.notNull().defaultTo(1))
                .execute();

            await db.schema
                .createIndex('chat_agent_config_guild_unique_idx')
                .on('chat_agent_config')
                .column('guild_id')
                .unique()
                .execute();
        },
        down: async (db: Kysely<any>) => {
            await db.schema.dropTable('chat_agent_config').ifExists().execute();
        },
    },
};
