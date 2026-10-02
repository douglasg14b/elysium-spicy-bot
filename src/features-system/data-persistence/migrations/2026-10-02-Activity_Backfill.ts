import { Kysely } from 'kysely';
import { DB_TYPE } from '../../../environment';

export async function up(db: Kysely<any>): Promise<void> {
    await migration[DB_TYPE].up(db);
}

export async function down(db: Kysely<any>): Promise<void> {
    await migration[DB_TYPE].down(db);
}

/**
 * What activity needs to recover the messages it missed while the bot was down.
 *
 * `activity_recorder_sessions` holds one row per process that recorded activity: when it
 * started, when it was last seen alive (a heartbeat), and when the gap *before* it was
 * backfilled. The gap before session N runs from session N−1's `last_seen_at` to N's
 * `started_at`, so the table is all that is needed to find it again after a crash.
 *
 * `activity_events.message_id` makes a backfill safe to repeat: both the live recorder and
 * the backfill write it, and insert with `ON CONFLICT (message_id) DO NOTHING`. A plain
 * unique index, not a partial one, because that is what `ON CONFLICT (message_id)` infers
 * against on postgres — and both dialects let any number of rows hold NULL under it, so
 * reaction rows and every row written before this column existed are unaffected.
 *
 * No data copy: no existing row knows its message id.
 *
 * Sorts after the 2026-10-01 activity migrations, which create `activity_events`.
 */
async function addBackfillTables(
    db: Kysely<any>,
    types: { readonly id: 'serial' | 'integer'; readonly timestamp: 'timestamptz' | 'text' }
): Promise<void> {
    await db.schema
        .createTable('activity_recorder_sessions')
        .addColumn('id', types.id, (col) =>
            types.id === 'integer' ? col.primaryKey().autoIncrement() : col.primaryKey()
        )
        .addColumn('started_at', types.timestamp, (col) => col.notNull())
        .addColumn('last_seen_at', types.timestamp, (col) => col.notNull())
        .addColumn('gap_filled_at', types.timestamp)
        .execute();

    await db.schema.alterTable('activity_events').addColumn('message_id', 'text').execute();
    await db.schema
        .createIndex('activity_events_message_id_unique')
        .on('activity_events')
        .column('message_id')
        .unique()
        .execute();
}

/** Index first: SQLite refuses to drop a column an index still names. */
async function dropBackfillTables(db: Kysely<any>): Promise<void> {
    await db.schema.dropIndex('activity_events_message_id_unique').execute();
    await db.schema.alterTable('activity_events').dropColumn('message_id').execute();
    await db.schema.dropTable('activity_recorder_sessions').execute();
}

const migration = {
    postgres: {
        // Kysely already wraps a postgres migration in a transaction.
        up: async (db: Kysely<any>) => {
            await addBackfillTables(db, { id: 'serial', timestamp: 'timestamptz' });
        },
        down: dropBackfillTables,
    },
    sqlite: {
        /*
         * `SqliteAdapter.supportsTransactionalDdl` is false, so the migrator does not
         * wrap this; several statements need a transaction of their own to be atomic.
         * Every statement goes through `trx` — a query on `db` inside the callback waits
         * on the connection the transaction holds and never returns.
         */
        up: async (db: Kysely<any>) => {
            await db.transaction().execute(async (trx) => {
                await addBackfillTables(trx, { id: 'integer', timestamp: 'text' });
            });
        },
        down: async (db: Kysely<any>) => {
            await db.transaction().execute(async (trx) => {
                await dropBackfillTables(trx);
            });
        },
    },
};
