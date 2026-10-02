import { Kysely } from 'kysely';
import { DB_TYPE } from '../../../environment';

export async function up(db: Kysely<any>): Promise<void> {
    await migration[DB_TYPE].up(db);
}

export async function down(db: Kysely<any>): Promise<void> {
    await migration[DB_TYPE].down(db);
}

/**
 * Let a timed park count its deadline from the last qualifying message.
 *
 * `quiet_window` holds `{ durationMs, who, channelId? }` for a park whose `wake_at`
 * the scheduler may push back when someone is still talking, and is null for every
 * other park. Nullable, like `wait_message_id`: absence already means "count from the
 * park", which is what every existing row means, so none is rewritten.
 *
 * One statement per arm, so the SQLite arm needs no transaction of its own to be
 * atomic. Sorts after `2026-10-01-Create_Activity_Events` — Kysely refuses
 * out-of-order migrations, and the lookup this column drives reads that table.
 *
 * The thread-parent column on `activity_events` that the same lookup needs is a
 * migration of its own (`2026-10-01-Record_Activity_Thread_Parents`), because the
 * flow-runs test database applies its migrations one by one and has no
 * `activity_events` table to alter.
 */
const migration = {
    postgres: {
        up: async (db: Kysely<any>) => {
            await db.schema.alterTable('flow_runs').addColumn('quiet_window', 'jsonb').execute();
        },
        down: async (db: Kysely<any>) => {
            await db.schema.alterTable('flow_runs').dropColumn('quiet_window').execute();
        },
    },
    sqlite: {
        up: async (db: Kysely<any>) => {
            await db.schema.alterTable('flow_runs').addColumn('quiet_window', 'text').execute();
        },
        down: async (db: Kysely<any>) => {
            await db.schema.alterTable('flow_runs').dropColumn('quiet_window').execute();
        },
    },
};
