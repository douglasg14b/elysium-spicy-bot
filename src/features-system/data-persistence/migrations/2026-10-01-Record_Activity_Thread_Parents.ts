import { Kysely } from 'kysely';
import { DB_TYPE } from '../../../environment';

export async function up(db: Kysely<any>): Promise<void> {
    await migration[DB_TYPE].up(db);
}

export async function down(db: Kysely<any>): Promise<void> {
    await migration[DB_TYPE].down(db);
}

/**
 * Record the parent channel of an activity event that landed in a thread.
 *
 * "Messages in #some-channel" has to count a reply in a thread under it, and the
 * event's own `channel_id` is the thread's. So `parent_channel_id` carries the
 * parent, and the lookup matches `channel_id = X` and `parent_channel_id = X` as two
 * indexed queries, each `LIMIT 1`, taking the later — so neither dialect has to plan
 * an `OR` across two indexes. This adds the index for the second of those; the
 * existing `(guild_id, channel_id, occurred_at)` serves the first.
 *
 * Recorded for new events only. Nothing to backfill: no earlier row knows whether it
 * was in a thread, and the copied leveling history has no channel at all.
 *
 * Sorts after `2026-10-01-Create_Activity_Events`, which creates the table.
 */
async function addParentChannel(db: Kysely<any>): Promise<void> {
    await db.schema.alterTable('activity_events').addColumn('parent_channel_id', 'text').execute();
    await db.schema
        .createIndex('activity_events_guild_parent_channel_occurred_idx')
        .on('activity_events')
        .columns(['guild_id', 'parent_channel_id', 'occurred_at'])
        .execute();
}

/** Index first: SQLite refuses to drop a column an index still names. */
async function dropParentChannel(db: Kysely<any>): Promise<void> {
    await db.schema.dropIndex('activity_events_guild_parent_channel_occurred_idx').execute();
    await db.schema.alterTable('activity_events').dropColumn('parent_channel_id').execute();
}

const migration = {
    postgres: {
        // Kysely already wraps a postgres migration in a transaction.
        up: addParentChannel,
        down: dropParentChannel,
    },
    sqlite: {
        /*
         * `SqliteAdapter.supportsTransactionalDdl` is false, so the migrator does not
         * wrap this; two statements need a transaction of their own to be atomic. Every
         * statement goes through `trx` — a query on `db` inside the callback waits on
         * the connection the transaction holds and never returns.
         */
        up: async (db: Kysely<any>) => {
            await db.transaction().execute(async (trx) => {
                await addParentChannel(trx);
            });
        },
        down: async (db: Kysely<any>) => {
            await db.transaction().execute(async (trx) => {
                await dropParentChannel(trx);
            });
        },
    },
};
