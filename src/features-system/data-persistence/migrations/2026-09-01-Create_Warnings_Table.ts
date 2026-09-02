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
            await db.schema
                .createTable('warnings')
                .addColumn('id', 'serial', (col) => col.primaryKey())
                .addColumn('guild_id', 'text', (col) => col.notNull())
                .addColumn('user_id', 'text', (col) => col.notNull())
                .addColumn('issuer_id', 'text', (col) => col.notNull())
                .addColumn('slug', 'text', (col) => col.notNull())
                .addColumn('rule', 'text', (col) => col.notNull())
                .addColumn('description', 'text', (col) => col.notNull())
                .addColumn('issued_at', 'timestamptz', (col) => col.notNull())
                .addColumn('expires_at', 'timestamptz', (col) => col.notNull())
                .addColumn('cleared_at', 'timestamptz')
                .addColumn('cleared_by_id', 'text')
                .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
                .execute();

            await db.schema
                .createIndex('warnings_guild_slug_unique_idx')
                .on('warnings')
                .columns(['guild_id', 'slug'])
                .unique()
                .execute();
            await db.schema
                .createIndex('warnings_guild_active_idx')
                .on('warnings')
                .columns(['guild_id', 'cleared_at', 'expires_at'])
                .execute();
        },
        down: async (db: Kysely<any>) => {
            await db.schema.dropTable('warnings').ifExists().execute();
        },
    },
    sqlite: {
        up: async (db: Kysely<any>) => {
            await db.schema
                .createTable('warnings')
                .addColumn('id', 'integer', (col) => col.primaryKey().autoIncrement())
                .addColumn('guild_id', 'text', (col) => col.notNull())
                .addColumn('user_id', 'text', (col) => col.notNull())
                .addColumn('issuer_id', 'text', (col) => col.notNull())
                .addColumn('slug', 'text', (col) => col.notNull())
                .addColumn('rule', 'text', (col) => col.notNull())
                .addColumn('description', 'text', (col) => col.notNull())
                .addColumn('issued_at', 'text', (col) => col.notNull())
                .addColumn('expires_at', 'text', (col) => col.notNull())
                .addColumn('cleared_at', 'text')
                .addColumn('cleared_by_id', 'text')
                .addColumn('created_at', 'text', (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
                .execute();

            await db.schema
                .createIndex('warnings_guild_slug_unique_idx')
                .on('warnings')
                .columns(['guild_id', 'slug'])
                .unique()
                .execute();
            await db.schema
                .createIndex('warnings_guild_active_idx')
                .on('warnings')
                .columns(['guild_id', 'cleared_at', 'expires_at'])
                .execute();
        },
        down: async (db: Kysely<any>) => {
            await db.schema.dropTable('warnings').ifExists().execute();
        },
    },
};
