import { Kysely, sql } from 'kysely';
import { DB_TYPE } from '../../../environment';

export async function up(db: Kysely<any>): Promise<void> {
    await birthdayConfigTable[DB_TYPE].up(db);
}

export async function down(db: Kysely<any>): Promise<void> {
    await birthdayConfigTable[DB_TYPE].down(db);
}

const birthdayConfigTable = {
    postgres: {
        up: async (db: Kysely<any>) => {
            await db.schema
                .createTable('birthday_config')
                .addColumn('guild_id', 'text', (col) => col.primaryKey())
                .addColumn('announcement_channel_id', 'text', (col) => col.notNull())
                .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
                .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
                .addColumn('config_version', 'integer', (col) => col.notNull().defaultTo(1))
                .execute();
        },
        down: async (db: Kysely<any>) => {
            await db.schema.dropTable('birthday_config').execute();
        },
    },
    sqlite: {
        up: async (db: Kysely<any>) => {
            await db.schema
                .createTable('birthday_config')
                .addColumn('guild_id', 'text', (col) => col.primaryKey())
                .addColumn('announcement_channel_id', 'text', (col) => col.notNull())
                .addColumn('created_at', 'text', (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
                .addColumn('updated_at', 'text', (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
                .addColumn('config_version', 'integer', (col) => col.notNull().defaultTo(1))
                .execute();
        },
        down: async (db: Kysely<any>) => {
            await db.schema.dropTable('birthday_config').execute();
        },
    },
};
