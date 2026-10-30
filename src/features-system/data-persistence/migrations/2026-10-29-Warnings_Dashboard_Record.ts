import { Kysely } from 'kysely';
import { DB_TYPE } from '../../../environment';

export async function up(db: Kysely<any>): Promise<void> {
    await migration[DB_TYPE].up(db);
}

export async function down(db: Kysely<any>): Promise<void> {
    await migration[DB_TYPE].down(db);
}

/**
 * What a warning records about the people on it, and about its release and last edit
 * (`docs/plans/warnings-in-the-dashboard.md`, §1.1).
 *
 *  - `user_name`, `issuer_name`: the warned member's and the issuer's display names when it
 *    was issued, so the dashboard's list names people without asking Discord for each row.
 *  - `cleared_by_name`, `clear_reason`: who released it, by name, and why.
 *  - `edited_at`, `edited_by_id`, `edited_by_name`: the last edit only. The mod-log notice
 *    for each edit carries the before and after, so the channel holds the full trail.
 *
 * **All nullable, with no default, and no backfill.** Rows written before this have no
 * names to record; the dashboard shows the id then. Filling them would mean fetching every
 * historical member for a cosmetic gain on rows that age out in six months.
 *
 * The two arms differ only in `edited_at`'s type, matching the table's other dates
 * (`timestamptz` on Postgres, `text` on SQLite — `2026-09-01-Create_Warnings_Table`). They
 * are written out separately so a dialect-specific change to one cannot silently apply to
 * the other. `down` drops every column, in reverse; SQLite has dropped a column since 3.35,
 * and no index names any of them.
 */
const TEXT_COLUMNS = [
    'user_name',
    'issuer_name',
    'cleared_by_name',
    'clear_reason',
    'edited_by_id',
    'edited_by_name',
] as const;

const migration = {
    postgres: {
        up: async (db: Kysely<any>) => {
            for (const column of TEXT_COLUMNS) {
                await db.schema.alterTable('warnings').addColumn(column, 'text').execute();
            }
            await db.schema.alterTable('warnings').addColumn('edited_at', 'timestamptz').execute();
        },
        down: async (db: Kysely<any>) => {
            await db.schema.alterTable('warnings').dropColumn('edited_at').execute();
            for (const column of [...TEXT_COLUMNS].reverse()) {
                await db.schema.alterTable('warnings').dropColumn(column).execute();
            }
        },
    },
    sqlite: {
        up: async (db: Kysely<any>) => {
            for (const column of TEXT_COLUMNS) {
                await db.schema.alterTable('warnings').addColumn(column, 'text').execute();
            }
            await db.schema.alterTable('warnings').addColumn('edited_at', 'text').execute();
        },
        down: async (db: Kysely<any>) => {
            await db.schema.alterTable('warnings').dropColumn('edited_at').execute();
            for (const column of [...TEXT_COLUMNS].reverse()) {
                await db.schema.alterTable('warnings').dropColumn(column).execute();
            }
        },
    },
};
