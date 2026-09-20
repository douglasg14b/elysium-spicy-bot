import { Kysely, sql } from 'kysely';
import { DB_TYPE } from '../../../environment';

export async function up(db: Kysely<any>): Promise<void> {
    await migration[DB_TYPE].up(db);
}

export async function down(db: Kysely<any>): Promise<void> {
    await migration[DB_TYPE].down(db);
}

/**
 * Creates `guild_settings`: server-wide configuration owned by no single feature.
 *
 * `staff_role_ids` is a JSON column rather than a join table. The list is read whole
 * and written whole, and nothing queries across guilds for a given role, so a second
 * table would add a write path and a consistency problem to buy queries nobody makes.
 * Same shape as `ticketing_config.config`, which already stores a role list this way.
 *
 * Defaulted to `'[]'` so a row can be created by a future setting without inventing a
 * staff list: an absent column would make "no staff configured" and "column is null"
 * two states the repo has to collapse, and the install refusal depends on that answer
 * being one thing.
 *
 * The unique index on `guild_id` is what makes this one-row-per-guild. Without it the
 * repo's read-then-write upsert can leave two rows under concurrent writes, and the
 * `selectAll().executeTakeFirst()` read would then silently return whichever came back
 * first — settings that appear to flip between values with no write explaining it.
 */
const migration = {
    postgres: {
        up: async (db: Kysely<any>) => {
            await db.schema
                .createTable('guild_settings')
                .addColumn('id', 'serial', (col) => col.primaryKey())
                .addColumn('guild_id', 'text', (col) => col.notNull())
                .addColumn('staff_role_ids', 'jsonb', (col) => col.notNull().defaultTo(sql`'[]'::jsonb`))
                .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
                .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
                .addColumn('config_version', 'integer', (col) => col.notNull().defaultTo(1))
                .execute();

            await db.schema
                .createIndex('guild_settings_guild_unique_idx')
                .on('guild_settings')
                .column('guild_id')
                .unique()
                .execute();
        },
        down: async (db: Kysely<any>) => {
            await db.schema.dropTable('guild_settings').ifExists().execute();
        },
    },
    sqlite: {
        up: async (db: Kysely<any>) => {
            await db.schema
                .createTable('guild_settings')
                .addColumn('id', 'integer', (col) => col.primaryKey().autoIncrement())
                .addColumn('guild_id', 'text', (col) => col.notNull())
                .addColumn('staff_role_ids', 'text', (col) => col.notNull().defaultTo('[]'))
                // ISO-8601 with an explicit `Z`, matching every other table here:
                // `CURRENT_TIMESTAMP` yields a zoneless space-separated string that V8
                // parses as local time, while the repo writes `toISOString()` UTC.
                .addColumn('created_at', 'text', (col) =>
                    col.notNull().defaultTo(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`)
                )
                .addColumn('updated_at', 'text', (col) =>
                    col.notNull().defaultTo(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`)
                )
                .addColumn('config_version', 'integer', (col) => col.notNull().defaultTo(1))
                .execute();

            await db.schema
                .createIndex('guild_settings_guild_unique_idx')
                .on('guild_settings')
                .column('guild_id')
                .unique()
                .execute();
        },
        down: async (db: Kysely<any>) => {
            await db.schema.dropTable('guild_settings').ifExists().execute();
        },
    },
};
