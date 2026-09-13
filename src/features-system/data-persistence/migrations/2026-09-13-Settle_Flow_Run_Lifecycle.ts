import { Kysely, sql } from 'kysely';
import { DB_TYPE } from '../../../environment';

export async function up(db: Kysely<any>): Promise<void> {
    await migration[DB_TYPE].up(db);
}

export async function down(db: Kysely<any>): Promise<void> {
    await migration[DB_TYPE].down(db);
}

/**
 * Settle the durable-run lifecycle.
 *
 * `pending` was never accurate: a `flow_runs` row is only ever inserted when a
 * run parks, so every row carrying that status is in fact a *suspended* run. The
 * rename makes the column say what is true, which matters now that `running`
 * becomes a real resume claim rather than a status nothing writes.
 *
 * `claimed_at` records when a resumer took that claim, so a claim abandoned by a
 * killed process can be reclaimed instead of stranding a live run forever.
 *
 * Existing rows are rewritten in place — no run loses its resume position, its
 * wait payload, or its visit budget.
 */
const migration = {
    postgres: {
        up: async (db: Kysely<any>) => {
            await sql`UPDATE flow_runs SET status = 'suspended' WHERE status = 'pending'`.execute(db);

            await db.schema
                .alterTable('flow_runs')
                .alterColumn('status', (col) => col.setDefault('suspended'))
                .execute();

            await db.schema.alterTable('flow_runs').addColumn('claimed_at', 'timestamptz').execute();
        },
        down: async (db: Kysely<any>) => {
            await db.schema.alterTable('flow_runs').dropColumn('claimed_at').execute();

            await db.schema
                .alterTable('flow_runs')
                .alterColumn('status', (col) => col.setDefault('pending'))
                .execute();

            await sql`UPDATE flow_runs SET status = 'pending' WHERE status IN ('suspended', 'running')`.execute(db);
        },
    },
    sqlite: {
        up: async (db: Kysely<any>) => {
            await sql`UPDATE flow_runs SET status = 'suspended' WHERE status = 'pending'`.execute(db);

            // sqlite cannot alter a column default, and rebuilding the table to
            // retire this one would copy every row and recreate five indexes to
            // no effect: `FlowRunTable.status` is not `Generated`, so Kysely's
            // `Insertable` makes omitting it a compile error. The default is
            // therefore unreachable through the typed client, and the repo is the
            // only writer. Left as-is deliberately, not overlooked.
            await db.schema.alterTable('flow_runs').addColumn('claimed_at', 'text').execute();
        },
        down: async (db: Kysely<any>) => {
            await db.schema.alterTable('flow_runs').dropColumn('claimed_at').execute();

            await sql`UPDATE flow_runs SET status = 'pending' WHERE status IN ('suspended', 'running')`.execute(db);
        },
    },
};
