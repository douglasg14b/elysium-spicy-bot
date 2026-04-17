import { Kysely, sql } from 'kysely';
import { DB_TYPE } from '../../../environment';

export async function up(db: Kysely<any>): Promise<void> {
    await migration[DB_TYPE].up(db);
}

export async function down(db: Kysely<any>): Promise<void> {
    await migration[DB_TYPE].down(db);
}

const migration = {
    postgres: {
        up: async (db: Kysely<any>) => {
            await db.schema.alterTable('birthdays').addColumn('last_announced_at', 'timestamptz').execute();

            await db.schema
                .createTable('birthday_config')
                .addColumn('id', 'serial', (col) => col.primaryKey())
                .addColumn('guild_id', 'text', (col) => col.notNull())
                .addColumn('announcement_channel_id', 'text', (col) => col.notNull())
                .addColumn('context_channel_id', 'text')
                .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
                .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
                .addColumn('config_version', 'integer', (col) => col.notNull().defaultTo(1))
                .execute();

            await db.schema.createIndex('birthday_config_guild_idx').on('birthday_config').column('guild_id').execute();
            await db.schema
                .createIndex('birthday_config_guild_unique_idx')
                .on('birthday_config')
                .column('guild_id')
                .unique()
                .execute();
        },
        down: async (db: Kysely<any>) => {
            await db.schema.dropTable('birthday_config').ifExists().execute();
            await db.schema.alterTable('birthdays').dropColumn('last_announced_at').execute();
        },
    },
    sqlite: {
        up: async (db: Kysely<any>) => {
            await db.schema.alterTable('birthdays').addColumn('last_announced_at', 'text').execute();

            await db.schema
                .createTable('birthday_config')
                .addColumn('id', 'integer', (col) => col.primaryKey().autoIncrement())
                .addColumn('guild_id', 'text', (col) => col.notNull())
                .addColumn('announcement_channel_id', 'text', (col) => col.notNull())
                .addColumn('context_channel_id', 'text')
                .addColumn('created_at', 'text', (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
                .addColumn('updated_at', 'text', (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
                .addColumn('config_version', 'integer', (col) => col.notNull().defaultTo(1))
                .execute();

            await db.schema.createIndex('birthday_config_guild_idx').on('birthday_config').column('guild_id').execute();
            await db.schema
                .createIndex('birthday_config_guild_unique_idx')
                .on('birthday_config')
                .column('guild_id')
                .unique()
                .execute();
        },
        down: async (db: Kysely<any>) => {
            await db.schema.dropTable('birthday_config').ifExists().execute();
            await db.schema.alterTable('birthdays').dropColumn('last_announced_at').execute();
        },
    },
};
