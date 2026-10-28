import { Kysely } from 'kysely';
import { DB_TYPE } from '../../../environment';

export async function up(db: Kysely<any>): Promise<void> {
    await migration[DB_TYPE].up(db);
}

export async function down(db: Kysely<any>): Promise<void> {
    await migration[DB_TYPE].down(db);
}

/**
 * Creates `flow_posted_messages`: one row per message a flow's block posted carrying buttons,
 * so a press can find the flow, node and run that posted it. See `flowPostedMessagesSchema.ts`
 * (in `flows/logic/`) for what a row means.
 *
 * Keyed by `message_id`, the Discord id a press arrives naming — the only read step 2 makes.
 * `subject_id` is null for a run about nobody, `ticket_id` for every block but Open Ticket.
 * `posted_at` has no default: the one writer always sets it.
 *
 * No foreign key to `flows` or `tickets`, matching every other flows table: a deleted flow or
 * ticket leaves a message in Discord whose buttons still need an answer.
 *
 * Nothing is backfilled: no block posted buttons before this.
 */
const migration = {
    postgres: {
        up: async (db: Kysely<any>) => {
            await db.schema
                .createTable('flow_posted_messages')
                .addColumn('message_id', 'text', (col) => col.primaryKey())
                .addColumn('guild_id', 'text', (col) => col.notNull())
                .addColumn('channel_id', 'text', (col) => col.notNull())
                .addColumn('flow_id', 'text', (col) => col.notNull())
                .addColumn('node_id', 'text', (col) => col.notNull())
                .addColumn('run_id', 'text', (col) => col.notNull())
                .addColumn('subject_id', 'text')
                .addColumn('ticket_id', 'integer')
                .addColumn('posted_at', 'timestamptz', (col) => col.notNull())
                .execute();
        },
        down: async (db: Kysely<any>) => {
            await db.schema.dropTable('flow_posted_messages').ifExists().execute();
        },
    },
    sqlite: {
        up: async (db: Kysely<any>) => {
            await db.schema
                .createTable('flow_posted_messages')
                .addColumn('message_id', 'text', (col) => col.primaryKey())
                .addColumn('guild_id', 'text', (col) => col.notNull())
                .addColumn('channel_id', 'text', (col) => col.notNull())
                .addColumn('flow_id', 'text', (col) => col.notNull())
                .addColumn('node_id', 'text', (col) => col.notNull())
                .addColumn('run_id', 'text', (col) => col.notNull())
                .addColumn('subject_id', 'text')
                .addColumn('ticket_id', 'integer')
                // ISO-8601 with an explicit `Z`, as every flows table stores a time on sqlite.
                .addColumn('posted_at', 'text', (col) => col.notNull())
                .execute();
        },
        down: async (db: Kysely<any>) => {
            await db.schema.dropTable('flow_posted_messages').ifExists().execute();
        },
    },
};
