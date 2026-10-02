import { Kysely, sql } from 'kysely';
import { DB_TYPE } from '../../../environment';

/**
 * Splits "who was active where" out of leveling's XP ledger.
 *
 * `leveling_activity_events` becomes `leveling_xp_grants`, gains a nullable
 * `activity_event_id`, and its message and reaction rows seed a new `activity_events`
 * table under the **same ids**, so the link is a single set-based UPDATE. Voice and flow
 * grants have no activity event and stay unlinked.
 *
 * `activity_event_id` is deliberately a plain column, not a foreign key: nothing deletes
 * activity events yet, and the constraint (plus the index `ON DELETE SET NULL` would need)
 * is decided together with retention. See `docs/plans/activity-events.md`.
 *
 * **Index names on the renamed table keep their `leveling_activity_events_*` names**, as do
 * (on postgres) its primary-key constraint and id sequence. SQLite cannot rename an index,
 * and dropping and rebuilding them on the largest table in the database to fix a name is
 * not worth it.
 */
export async function up(db: Kysely<any>): Promise<void> {
    await migration[DB_TYPE].up(db);
}

export async function down(db: Kysely<any>): Promise<void> {
    await migration[DB_TYPE].down(db);
}

/**
 * Steps 1-6 of the split, identical on both dialects apart from column types.
 *
 * Indexes are created after the copy so the INSERT does not maintain them row by row.
 */
async function splitActivityFromXpGrants(
    db: Kysely<any>,
    types: { readonly id: 'serial' | 'integer'; readonly timestamp: 'timestamptz' | 'text' }
): Promise<void> {
    await db.schema.alterTable('leveling_activity_events').renameTo('leveling_xp_grants').execute();
    await db.schema.alterTable('leveling_xp_grants').addColumn('activity_event_id', 'integer').execute();

    await db.schema
        .createTable('activity_events')
        .addColumn('id', types.id, (col) =>
            types.id === 'integer' ? col.primaryKey().autoIncrement() : col.primaryKey()
        )
        .addColumn('guild_id', 'text', (col) => col.notNull())
        .addColumn('user_id', 'text', (col) => col.notNull())
        .addColumn('channel_id', 'text')
        .addColumn('kind', 'text', (col) => col.notNull())
        .addColumn('occurred_at', types.timestamp, (col) => col.notNull())
        .execute();

    // History predates channel ids, so every copied row has a null channel.
    await sql`
        INSERT INTO activity_events (id, guild_id, user_id, channel_id, kind, occurred_at)
        SELECT id, guild_id, user_id, NULL, activity_type, occurred_at
        FROM leveling_xp_grants
        WHERE activity_type IN ('message', 'reaction')
    `.execute(db);

    // Ids were kept above, so each grant's own id is its activity event's id.
    await sql`
        UPDATE leveling_xp_grants
        SET activity_event_id = id
        WHERE activity_type IN ('message', 'reaction')
    `.execute(db);

    await db.schema
        .createIndex('activity_events_guild_user_occurred_idx')
        .on('activity_events')
        .columns(['guild_id', 'user_id', 'occurred_at'])
        .execute();
    await db.schema
        .createIndex('activity_events_guild_channel_occurred_idx')
        .on('activity_events')
        .columns(['guild_id', 'channel_id', 'occurred_at'])
        .execute();
}

async function rejoinActivityIntoXpGrants(db: Kysely<any>): Promise<void> {
    await db.schema.dropTable('activity_events').execute();
    await db.schema.alterTable('leveling_xp_grants').dropColumn('activity_event_id').execute();
    await db.schema.alterTable('leveling_xp_grants').renameTo('leveling_activity_events').execute();
}

const migration = {
    postgres: {
        // Kysely already wraps a postgres migration in a transaction.
        up: async (db: Kysely<any>) => {
            await splitActivityFromXpGrants(db, { id: 'serial', timestamp: 'timestamptz' });

            /*
             * The explicit-id INSERT does not advance the `serial` sequence, so without this
             * the first live insert would collide with a copied id. `is_called = false` makes
             * the next `nextval` return exactly this value: 1 on an empty table, max + 1
             * otherwise.
             */
            await sql`
                SELECT setval(
                    pg_get_serial_sequence('activity_events', 'id'),
                    COALESCE(MAX(id), 0) + 1,
                    false
                )
                FROM activity_events
            `.execute(db);
        },
        down: async (db: Kysely<any>) => {
            await rejoinActivityIntoXpGrants(db);
        },
    },
    sqlite: {
        /*
         * `SqliteAdapter.supportsTransactionalDdl` is false, so the migrator does not wrap
         * this in a transaction; without one, a failure would leave the ledger half-renamed.
         * `db` here is the migrator's connection-bound instance, and every statement must
         * go through `trx` — a query on `db` inside the callback waits on the connection
         * the transaction holds and never returns.
         *
         * No sequence fix-up: `AUTOINCREMENT` advances `sqlite_sequence` on an explicit-id
         * insert by itself.
         */
        up: async (db: Kysely<any>) => {
            await db.transaction().execute(async (trx) => {
                await splitActivityFromXpGrants(trx, { id: 'integer', timestamp: 'text' });
            });
        },
        down: async (db: Kysely<any>) => {
            await db.transaction().execute(async (trx) => {
                await rejoinActivityIntoXpGrants(trx);
            });
        },
    },
};
