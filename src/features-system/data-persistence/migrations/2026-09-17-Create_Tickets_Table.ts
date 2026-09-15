import { Kysely, sql } from 'kysely';
import { DB_TYPE } from '../../../environment';

export async function up(db: Kysely<any>): Promise<void> {
    await migration[DB_TYPE].up(db);
}

export async function down(db: Kysely<any>): Promise<void> {
    await migration[DB_TYPE].down(db);
}

/**
 * Creates the durable `tickets` table.
 *
 * The table starts empty by decision: existing tickets are finished by hand
 * rather than backfilled out of Discord, so there is no data migration here and
 * nothing that can be damaged if the postgres arm turns out to be wrong.
 *
 * Two indexes, both earning their place from a named consumer:
 *   - the unique `(guild_id, ticket_number)` pair, which is only safe to declare
 *     because numbering is atomic from the first row rather than inherited from
 *     channels that may already collide;
 *   - `(guild_id, subject_id, type, status)`, covering the hot condition
 *     "does this member have an open ticket of type X?" — asked per member on
 *     join, so it must not degrade to a scan.
 */
const migration = {
    postgres: {
        up: async (db: Kysely<any>) => {
            await db.schema
                .createTable('tickets')
                .addColumn('id', 'serial', (col) => col.primaryKey())
                .addColumn('guild_id', 'text', (col) => col.notNull())
                .addColumn('ticket_number', 'integer', (col) => col.notNull())
                .addColumn('type', 'text', (col) => col.notNull())
                .addColumn('status', 'text', (col) => col.notNull())
                .addColumn('subject_id', 'text', (col) => col.notNull())
                .addColumn('opener_id', 'text')
                .addColumn('claimer_id', 'text')
                .addColumn('channel_id', 'text')
                .addColumn('title', 'text', (col) => col.notNull())
                .addColumn('reason', 'text', (col) => col.notNull())
                .addColumn('opened_at', 'timestamptz', (col) => col.notNull())
                .addColumn('claimed_at', 'timestamptz')
                .addColumn('closed_at', 'timestamptz')
                .addColumn('deleted_at', 'timestamptz')
                .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
                .execute();

            await db.schema
                .createIndex('tickets_guild_number_unique_idx')
                .on('tickets')
                .columns(['guild_id', 'ticket_number'])
                .unique()
                .execute();
            await db.schema
                .createIndex('tickets_guild_subject_type_status_idx')
                .on('tickets')
                .columns(['guild_id', 'subject_id', 'type', 'status'])
                .execute();
            await db.schema
                .createIndex('tickets_channel_idx')
                .on('tickets')
                .columns(['channel_id'])
                .execute();
        },
        down: async (db: Kysely<any>) => {
            await db.schema.dropTable('tickets').ifExists().execute();
        },
    },
    sqlite: {
        up: async (db: Kysely<any>) => {
            await db.schema
                .createTable('tickets')
                .addColumn('id', 'integer', (col) => col.primaryKey().autoIncrement())
                .addColumn('guild_id', 'text', (col) => col.notNull())
                .addColumn('ticket_number', 'integer', (col) => col.notNull())
                .addColumn('type', 'text', (col) => col.notNull())
                .addColumn('status', 'text', (col) => col.notNull())
                .addColumn('subject_id', 'text', (col) => col.notNull())
                .addColumn('opener_id', 'text')
                .addColumn('claimer_id', 'text')
                .addColumn('channel_id', 'text')
                .addColumn('title', 'text', (col) => col.notNull())
                .addColumn('reason', 'text', (col) => col.notNull())
                .addColumn('opened_at', 'text', (col) => col.notNull())
                .addColumn('claimed_at', 'text')
                .addColumn('closed_at', 'text')
                .addColumn('deleted_at', 'text')
                .addColumn('updated_at', 'text', (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
                .execute();

            await db.schema
                .createIndex('tickets_guild_number_unique_idx')
                .on('tickets')
                .columns(['guild_id', 'ticket_number'])
                .unique()
                .execute();
            await db.schema
                .createIndex('tickets_guild_subject_type_status_idx')
                .on('tickets')
                .columns(['guild_id', 'subject_id', 'type', 'status'])
                .execute();
            await db.schema
                .createIndex('tickets_channel_idx')
                .on('tickets')
                .columns(['channel_id'])
                .execute();
        },
        down: async (db: Kysely<any>) => {
            await db.schema.dropTable('tickets').ifExists().execute();
        },
    },
};
