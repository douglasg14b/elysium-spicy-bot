import { Kysely, sql } from 'kysely';
import { DB_TYPE } from '../../../environment';

export async function up(db: Kysely<any>): Promise<void> {
    await migration[DB_TYPE].up(db);
}

export async function down(db: Kysely<any>): Promise<void> {
    await migration[DB_TYPE].down(db);
}

/**
 * Avatars for `member_names` (`docs/plans/member-names.md`, step 2).
 *
 * `member_names.avatar_hash`: the account avatar's hash Discord last reported for the row,
 * null when they have none set. `member_names.avatar_checked_at`: when that hash was last
 * read from Discord — null means never, which is what tells "never checked" from "no avatar".
 * Both nullable with no default and not backfilled: every existing row reads as never
 * checked, until the bot next sees that person (a sweep, an update, a leave) or — for
 * somebody already gone — the dashboard's name lookup refreshes them (`resolveMemberNames`).
 *
 * `member_avatars`: the picture itself, one row per account — an account avatar is the same
 * in every server — so it is shared by every server holding a `member_names` row for that
 * user. `avatar_hash` is the hash of the picture stored, which the dashboard's `?v=` names.
 * `bytes` is `bytea` on postgres and `blob` on sqlite, and the **last column**, for the reason
 * `2026-10-24-Create_Guild_Uploads.ts` gives: sqlite walks a blob's overflow pages to reach
 * any column after it.
 *
 * The unique index on `user_id` is what each download's `ON CONFLICT` names: a new avatar
 * replaces the old picture rather than adding a row.
 */
const migration = {
    postgres: {
        up: async (db: Kysely<any>) => {
            await db.schema.alterTable('member_names').addColumn('avatar_hash', 'text').execute();
            await db.schema.alterTable('member_names').addColumn('avatar_checked_at', 'timestamptz').execute();

            await db.schema
                .createTable('member_avatars')
                .addColumn('id', 'serial', (col) => col.primaryKey())
                .addColumn('user_id', 'text', (col) => col.notNull())
                .addColumn('avatar_hash', 'text', (col) => col.notNull())
                .addColumn('content_type', 'text', (col) => col.notNull())
                .addColumn('fetched_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
                .addColumn('bytes', 'bytea', (col) => col.notNull())
                .execute();

            await db.schema
                .createIndex('member_avatars_user_unique_idx')
                .on('member_avatars')
                .column('user_id')
                .unique()
                .execute();
        },
        down: async (db: Kysely<any>) => {
            await db.schema.dropTable('member_avatars').ifExists().execute();
            await db.schema.alterTable('member_names').dropColumn('avatar_checked_at').execute();
            await db.schema.alterTable('member_names').dropColumn('avatar_hash').execute();
        },
    },
    sqlite: {
        up: async (db: Kysely<any>) => {
            await db.schema.alterTable('member_names').addColumn('avatar_hash', 'text').execute();
            // ISO-8601 with an explicit `Z`, as the repo writes every time here.
            await db.schema.alterTable('member_names').addColumn('avatar_checked_at', 'text').execute();

            await db.schema
                .createTable('member_avatars')
                .addColumn('id', 'integer', (col) => col.primaryKey().autoIncrement())
                .addColumn('user_id', 'text', (col) => col.notNull())
                .addColumn('avatar_hash', 'text', (col) => col.notNull())
                .addColumn('content_type', 'text', (col) => col.notNull())
                // ISO-8601 with an explicit `Z`, as the repo writes every time here.
                .addColumn('fetched_at', 'text', (col) =>
                    col.notNull().defaultTo(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`)
                )
                .addColumn('bytes', 'blob', (col) => col.notNull())
                .execute();

            await db.schema
                .createIndex('member_avatars_user_unique_idx')
                .on('member_avatars')
                .column('user_id')
                .unique()
                .execute();
        },
        down: async (db: Kysely<any>) => {
            await db.schema.dropTable('member_avatars').ifExists().execute();
            // SQLite 3.35+ drops a column that no index or constraint names; neither is in one.
            await db.schema.alterTable('member_names').dropColumn('avatar_checked_at').execute();
            await db.schema.alterTable('member_names').dropColumn('avatar_hash').execute();
        },
    },
};
