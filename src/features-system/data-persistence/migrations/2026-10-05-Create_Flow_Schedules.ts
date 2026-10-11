import { Kysely, sql } from 'kysely';
import { DB_TYPE } from '../../../environment';

export async function up(db: Kysely<any>): Promise<void> {
    await migration[DB_TYPE].up(db);
}

export async function down(db: Kysely<any>): Promise<void> {
    await migration[DB_TYPE].down(db);
}

/**
 * Creates `flow_schedules`: one row per Schedule trigger node, holding when it next fires.
 * See `flowSchedulesSchema.ts` for what a row means.
 *
 * Dated 2026-10-05 so it sorts after `2026-10-04-Guild_Settings_Time_Zone`: Kysely refuses
 * a pending migration that sorts before one already applied.
 *
 * Three indexes:
 *
 *  - **unique on `(flow_id, node_id)`** — one row per trigger node. A constraint rather
 *    than a speed-up: it is what makes reconcile's upsert a replace.
 *  - on `next_run_at` — the tick's "what is due" read, every 15 seconds.
 *  - on `guild_id` — reconcile reads and prunes one guild at a time.
 *
 * No foreign key to `flows`, matching every other flows table: reconcile deletes a row
 * whose flow or node is gone.
 *
 * Nothing is backfilled here. The bot reconciles every guild it is in at startup, which
 * gives each existing Schedule node its row — and no flow saved before this existed can
 * hold one anyway.
 */
const migration = {
    postgres: {
        up: async (db: Kysely<any>) => {
            await db.schema
                .createTable('flow_schedules')
                .addColumn('id', 'serial', (col) => col.primaryKey())
                .addColumn('guild_id', 'text', (col) => col.notNull())
                .addColumn('flow_id', 'text', (col) => col.notNull())
                .addColumn('node_id', 'text', (col) => col.notNull())
                .addColumn('config_key', 'text', (col) => col.notNull())
                .addColumn('next_run_at', 'timestamptz')
                .addColumn('last_run_id', 'text')
                .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
                .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
                .execute();

            await db.schema
                .createIndex('flow_schedules_flow_node_unique_idx')
                .on('flow_schedules')
                .columns(['flow_id', 'node_id'])
                .unique()
                .execute();
            await db.schema.createIndex('flow_schedules_next_run_at_idx').on('flow_schedules').column('next_run_at').execute();
            await db.schema.createIndex('flow_schedules_guild_id_idx').on('flow_schedules').column('guild_id').execute();
        },
        down: async (db: Kysely<any>) => {
            await db.schema.dropTable('flow_schedules').ifExists().execute();
        },
    },
    sqlite: {
        up: async (db: Kysely<any>) => {
            await db.schema
                .createTable('flow_schedules')
                .addColumn('id', 'integer', (col) => col.primaryKey().autoIncrement())
                .addColumn('guild_id', 'text', (col) => col.notNull())
                .addColumn('flow_id', 'text', (col) => col.notNull())
                .addColumn('node_id', 'text', (col) => col.notNull())
                .addColumn('config_key', 'text', (col) => col.notNull())
                .addColumn('next_run_at', 'text')
                .addColumn('last_run_id', 'text')
                // ISO-8601 with an explicit `Z`, for the reason the `flow_drafts` migration
                // gives: `CURRENT_TIMESTAMP` is zoneless and V8 reads it as local time. The
                // repo always writes both, so these only ever cover a hand-inserted row.
                .addColumn('created_at', 'text', (col) =>
                    col.notNull().defaultTo(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`)
                )
                .addColumn('updated_at', 'text', (col) =>
                    col.notNull().defaultTo(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`)
                )
                .execute();

            await db.schema
                .createIndex('flow_schedules_flow_node_unique_idx')
                .on('flow_schedules')
                .columns(['flow_id', 'node_id'])
                .unique()
                .execute();
            await db.schema.createIndex('flow_schedules_next_run_at_idx').on('flow_schedules').column('next_run_at').execute();
            await db.schema.createIndex('flow_schedules_guild_id_idx').on('flow_schedules').column('guild_id').execute();
        },
        down: async (db: Kysely<any>) => {
            await db.schema.dropTable('flow_schedules').ifExists().execute();
        },
    },
};
