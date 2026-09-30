import { Kysely, sql } from 'kysely';
import { DB_TYPE } from '../../../environment';

export async function up(db: Kysely<any>): Promise<void> {
    await migration[DB_TYPE].up(db);
}

export async function down(db: Kysely<any>): Promise<void> {
    await migration[DB_TYPE].down(db);
}

/**
 * Creates `flow_drafts`: one operator's unsaved canvas for one flow.
 *
 * The builder autosaves here, and a save that would put an incomplete graph on a live
 * flow lands here instead. See `flowDraftsSchema.ts` for what a draft is and is not.
 *
 * One index, and it is a constraint rather than a speed-up: **unique on
 * `(flow_id, author_id)`** — one draft per operator per flow. It is what makes the
 * repo's upsert a replace rather than a second row, and its `flow_id` prefix serves
 * the only list read there is ("every draft of this flow").
 *
 * No foreign key to `flows`, matching every other flows table here: sqlite's
 * table-rebuild-on-alter makes FKs fragile, and `flowsRepo.deleteByFlowId` removes a
 * flow's drafts in the same transaction as the flow instead.
 */
const migration = {
    postgres: {
        up: async (db: Kysely<any>) => {
            await db.schema
                .createTable('flow_drafts')
                .addColumn('id', 'serial', (col) => col.primaryKey())
                .addColumn('flow_id', 'text', (col) => col.notNull())
                .addColumn('guild_id', 'text', (col) => col.notNull())
                .addColumn('author_id', 'text', (col) => col.notNull())
                .addColumn('author_name', 'text', (col) => col.notNull())
                .addColumn('name', 'text', (col) => col.notNull())
                .addColumn('graph', 'jsonb', (col) => col.notNull())
                .addColumn('base_updated_at', 'timestamptz', (col) => col.notNull())
                .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
                .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
                .execute();

            await db.schema
                .createIndex('flow_drafts_flow_author_unique_idx')
                .on('flow_drafts')
                .columns(['flow_id', 'author_id'])
                .unique()
                .execute();
        },
        down: async (db: Kysely<any>) => {
            await db.schema.dropTable('flow_drafts').ifExists().execute();
        },
    },
    sqlite: {
        up: async (db: Kysely<any>) => {
            await db.schema
                .createTable('flow_drafts')
                .addColumn('id', 'integer', (col) => col.primaryKey().autoIncrement())
                .addColumn('flow_id', 'text', (col) => col.notNull())
                .addColumn('guild_id', 'text', (col) => col.notNull())
                .addColumn('author_id', 'text', (col) => col.notNull())
                .addColumn('author_name', 'text', (col) => col.notNull())
                .addColumn('name', 'text', (col) => col.notNull())
                .addColumn('graph', 'text', (col) => col.notNull())
                .addColumn('base_updated_at', 'text', (col) => col.notNull())
                // ISO-8601 with an explicit `Z`, for the reason the `flow_journey_links`
                // migration gives: `CURRENT_TIMESTAMP` is zoneless and V8 reads it as
                // local time. The repo always writes both, so these only ever cover a
                // hand-inserted row.
                .addColumn('created_at', 'text', (col) =>
                    col.notNull().defaultTo(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`)
                )
                .addColumn('updated_at', 'text', (col) =>
                    col.notNull().defaultTo(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`)
                )
                .execute();

            await db.schema
                .createIndex('flow_drafts_flow_author_unique_idx')
                .on('flow_drafts')
                .columns(['flow_id', 'author_id'])
                .unique()
                .execute();
        },
        down: async (db: Kysely<any>) => {
            await db.schema.dropTable('flow_drafts').ifExists().execute();
        },
    },
};
