import { Kysely, sql } from 'kysely';
import { DB_TYPE } from '../../../environment';

export async function up(db: Kysely<any>): Promise<void> {
    await migration[DB_TYPE].up(db);
}

export async function down(db: Kysely<any>): Promise<void> {
    await migration[DB_TYPE].down(db);
}

/**
 * Creates `member_names`: one row per member per server, so the dashboard can name an id
 * after the person has left. See `memberNamesSchema.ts` for what a row means.
 *
 * `nicknames` is a JSON list rather than a table of its own, as `guild_settings.staff_role_ids`
 * is: it is read whole, merged in JS and written whole, and nothing queries into it.
 * Defaulted to `'[]'` so a row never holds null for "no nicknames seen".
 *
 * The unique index on (`guild_id`, `user_id`) is what makes this one row per member per
 * server, and what every upsert's `ON CONFLICT` names. `member_names_user_idx` is for an
 * account rename, which finds every server's row for one user id.
 *
 * Nothing is backfilled here: the startup sweep fills in current members, and the names
 * other tables already hold are copied in by a later step (`docs/plans/member-names.md`).
 */
const migration = {
    postgres: {
        up: async (db: Kysely<any>) => {
            await db.schema
                .createTable('member_names')
                .addColumn('id', 'serial', (col) => col.primaryKey())
                .addColumn('guild_id', 'text', (col) => col.notNull())
                .addColumn('user_id', 'text', (col) => col.notNull())
                .addColumn('username', 'text', (col) => col.notNull())
                .addColumn('global_name', 'text')
                .addColumn('nickname', 'text')
                .addColumn('nicknames', 'jsonb', (col) => col.notNull().defaultTo(sql`'[]'::jsonb`))
                .addColumn('is_bot', 'boolean', (col) => col.notNull())
                .addColumn('in_server', 'boolean', (col) => col.notNull())
                .addColumn('left_at', 'timestamptz')
                .addColumn('first_seen_at', 'timestamptz', (col) => col.notNull())
                .addColumn('updated_at', 'timestamptz', (col) => col.notNull())
                .execute();

            await db.schema
                .createIndex('member_names_guild_user_unique_idx')
                .on('member_names')
                .columns(['guild_id', 'user_id'])
                .unique()
                .execute();

            await db.schema.createIndex('member_names_user_idx').on('member_names').column('user_id').execute();
        },
        down: async (db: Kysely<any>) => {
            await db.schema.dropTable('member_names').ifExists().execute();
        },
    },
    sqlite: {
        up: async (db: Kysely<any>) => {
            await db.schema
                .createTable('member_names')
                .addColumn('id', 'integer', (col) => col.primaryKey().autoIncrement())
                .addColumn('guild_id', 'text', (col) => col.notNull())
                .addColumn('user_id', 'text', (col) => col.notNull())
                .addColumn('username', 'text', (col) => col.notNull())
                .addColumn('global_name', 'text')
                .addColumn('nickname', 'text')
                .addColumn('nicknames', 'text', (col) => col.notNull().defaultTo('[]'))
                .addColumn('is_bot', 'integer', (col) => col.notNull())
                .addColumn('in_server', 'integer', (col) => col.notNull())
                // ISO-8601 with an explicit `Z`, as the repo writes every time here.
                .addColumn('left_at', 'text')
                .addColumn('first_seen_at', 'text', (col) => col.notNull())
                .addColumn('updated_at', 'text', (col) => col.notNull())
                .execute();

            await db.schema
                .createIndex('member_names_guild_user_unique_idx')
                .on('member_names')
                .columns(['guild_id', 'user_id'])
                .unique()
                .execute();

            await db.schema.createIndex('member_names_user_idx').on('member_names').column('user_id').execute();
        },
        down: async (db: Kysely<any>) => {
            await db.schema.dropTable('member_names').ifExists().execute();
        },
    },
};
