import { Kysely, sql } from 'kysely';
import { DB_TYPE } from '../../../environment';

export async function up(db: Kysely<any>): Promise<void> {
    await birthdayTable[DB_TYPE].up(db);
}

export async function down(db: Kysely<any>): Promise<void> {
    await birthdayTable[DB_TYPE].down(db);
}

const birthdayTable = {
    postgres: {
        up: async (db: Kysely<any>) => {
            await db.schema
                .createTable('birthdays')
                .addColumn('id', 'serial', (col) => col.primaryKey())
                .addColumn('guild_id', 'text', (col) => col.notNull())
                .addColumn('user_id', 'text', (col) => col.notNull())
                .addColumn('month', 'integer', (col) => col.notNull().check(sql`month >= 1 AND month <= 12`))
                .addColumn('day', 'integer', (col) => col.notNull().check(sql`day >= 1 AND day <= 31`))
                .addColumn('year', 'integer') // nullable for age calculation
                .addColumn('display_name', 'text', (col) => col.notNull())
                .addColumn('username', 'text', (col) => col.notNull())
                .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
                .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
                .addColumn('config_version', 'integer', (col) => col.notNull().defaultTo(1))
                .execute();

            // Create indexes for performance
            await db.schema.createIndex('birthdays_guild_id_idx').on('birthdays').column('guild_id').execute();

            await db.schema.createIndex('birthdays_user_id_idx').on('birthdays').column('user_id').execute();

            // Unique constraint: one birthday per user per guild
            await db.schema
                .createIndex('birthdays_guild_user_unique_idx')
                .on('birthdays')
                .columns(['guild_id', 'user_id'])
                .unique()
                .execute();

            // Index for birthday queries by month/day
            await db.schema.createIndex('birthdays_month_day_idx').on('birthdays').columns(['month', 'day']).execute();
        },

        down: async (db: Kysely<any>) => {
            await db.schema.dropTable('birthdays').execute();
        },
    },

    sqlite: {
        up: async (db: Kysely<any>) => {
            await db.schema
                .createTable('birthdays')
                .addColumn('id', 'integer', (col) => col.primaryKey().autoIncrement())
                .addColumn('guild_id', 'text', (col) => col.notNull())
                .addColumn('user_id', 'text', (col) => col.notNull())
                .addColumn('month', 'integer', (col) => col.notNull().check(sql`month >= 1 AND month <= 12`))
                .addColumn('day', 'integer', (col) => col.notNull().check(sql`day >= 1 AND day <= 31`))
                .addColumn('year', 'integer') // nullable for age calculation
                .addColumn('display_name', 'text', (col) => col.notNull())
                .addColumn('username', 'text', (col) => col.notNull())
                .addColumn('created_at', 'text', (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
                .addColumn('updated_at', 'text', (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
                .addColumn('config_version', 'integer', (col) => col.notNull().defaultTo(1))
                .execute();

            // Create indexes for performance
            await db.schema.createIndex('birthdays_guild_id_idx').on('birthdays').column('guild_id').execute();

            await db.schema.createIndex('birthdays_user_id_idx').on('birthdays').column('user_id').execute();

            // Unique constraint: one birthday per user per guild
            await db.schema
                .createIndex('birthdays_guild_user_unique_idx')
                .on('birthdays')
                .columns(['guild_id', 'user_id'])
                .unique()
                .execute();

            // Index for birthday queries by month/day
            await db.schema.createIndex('birthdays_month_day_idx').on('birthdays').columns(['month', 'day']).execute();
        },

        down: async (db: Kysely<any>) => {
            await db.schema.dropTable('birthdays').execute();
        },
    },
};
