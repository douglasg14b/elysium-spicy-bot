import { Kysely, sql } from 'kysely';
import { DB_TYPE } from '../../../environment';

export async function up(db: Kysely<any>): Promise<void> {
    await migration[DB_TYPE].up(db);
}

export async function down(db: Kysely<any>): Promise<void> {
    await migration[DB_TYPE].down(db);
}

/**
 * Creates `flow_button_messages`, the record of where a flow's trigger buttons were posted.
 *
 * Until now nothing recorded it: `deployFlowButtons` posted a message, returned its id,
 * and both callers threw it away. So deleting a flow left live buttons in a channel
 * pointing at nothing, and no code anywhere could find them to clean up.
 *
 * **The table starts empty and is not backfilled, and that has a visible consequence.**
 * Buttons posted before this migration have no row, so nothing can retire them — they
 * stay in their channels until somebody deletes the message by hand. Backfill is not
 * possible rather than merely skipped: the message ids were never written down, and
 * scanning every channel of every guild for messages that look like ours would be a
 * guess at which ones to delete. The UI says so plainly rather than implying the
 * cleanup found everything.
 *
 * One lookup index on `(guild_id, flow_id)`, which is how both undeploy and the
 * published-state lookup read the table.
 *
 * No unique index. Posting the same flow's buttons into two channels is legitimate and
 * is the reason this is a table rather than a column on `flows`; even `(guild_id,
 * message_id)` is left unconstrained, because a message id is already unique by
 * construction and an index promising otherwise would only mislead.
 *
 * No foreign key to `flows`, following `journeys.created_for_flow_id` — sqlite's
 * table-rebuild-on-alter makes FKs fragile here, and a row surviving its flow is the
 * *useful* state: it is what lets the buttons of a deleted flow still be found and
 * retired.
 */
const migration = {
    postgres: {
        up: async (db: Kysely<any>) => {
            await db.schema
                .createTable('flow_button_messages')
                .addColumn('id', 'serial', (col) => col.primaryKey())
                .addColumn('guild_id', 'text', (col) => col.notNull())
                .addColumn('flow_id', 'text', (col) => col.notNull())
                .addColumn('channel_id', 'text', (col) => col.notNull())
                .addColumn('message_id', 'text', (col) => col.notNull())
                // `jsonb`, matching every other JSON column in this schema
                // (`journeys.resources`, `flows.graph`, `flow_runs.log`). It matters
                // more than it looks: `SqliteJsonPlugin` parses this column back into
                // an array on sqlite and does not run on postgres, so a `text` column
                // here would hand the array back as a raw JSON *string* on postgres
                // only — typechecking cleanly against `JSONColumnType<string[]>` and
                // failing solely in production.
                .addColumn('node_ids', 'jsonb', (col) => col.notNull())
                .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
                .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
                .execute();

            await db.schema
                .createIndex('flow_button_messages_guild_flow_idx')
                .on('flow_button_messages')
                .columns(['guild_id', 'flow_id'])
                .execute();
        },
        down: async (db: Kysely<any>) => {
            await db.schema.dropTable('flow_button_messages').ifExists().execute();
        },
    },
    sqlite: {
        up: async (db: Kysely<any>) => {
            await db.schema
                .createTable('flow_button_messages')
                .addColumn('id', 'integer', (col) => col.primaryKey().autoIncrement())
                .addColumn('guild_id', 'text', (col) => col.notNull())
                .addColumn('flow_id', 'text', (col) => col.notNull())
                .addColumn('channel_id', 'text', (col) => col.notNull())
                .addColumn('message_id', 'text', (col) => col.notNull())
                .addColumn('node_ids', 'text', (col) => col.notNull())
                // ISO-8601 with an explicit `Z` rather than `CURRENT_TIMESTAMP`, which
                // yields a space-separated zoneless string that V8 parses as *local*
                // time while every value the repo writes is `toISOString()` UTC.
                // Invisible on a UTC host, wrong everywhere else.
                .addColumn('created_at', 'text', (col) =>
                    col.notNull().defaultTo(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`)
                )
                .addColumn('updated_at', 'text', (col) =>
                    col.notNull().defaultTo(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`)
                )
                .execute();

            await db.schema
                .createIndex('flow_button_messages_guild_flow_idx')
                .on('flow_button_messages')
                .columns(['guild_id', 'flow_id'])
                .execute();
        },
        down: async (db: Kysely<any>) => {
            await db.schema.dropTable('flow_button_messages').ifExists().execute();
        },
    },
};
