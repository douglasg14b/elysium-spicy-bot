import { Kysely, sql } from 'kysely';
import { DB_TYPE } from '../../../environment';

export async function up(db: Kysely<any>): Promise<void> {
    await migration[DB_TYPE].up(db);
}

export async function down(db: Kysely<any>): Promise<void> {
    await migration[DB_TYPE].down(db);
}

/**
 * Give a parked run somewhere to keep the values its blocks recorded.
 *
 * A run variable is written by one block and read by a later one, which works
 * inside a single segment without any storage at all. The moment a wait sits
 * between the two, the reader runs in a different process minutes or weeks later,
 * and anything held only in memory is gone — so the bag has to be part of what a
 * parked row remembers.
 *
 * **Its own column, not a member of `context_snapshot`.** The snapshot answers
 * "who is this run about and where", and every field of it is re-fetched from
 * Discord on resume; these are the run's own accumulated work, which exists
 * nowhere else and cannot be re-derived. Keeping them apart also means this
 * migration only ever *adds*: no stored row is rewritten, so nothing here can
 * lose a value, and the snapshot's own shape stays free for the change that
 * widens it.
 *
 * Existing rows get `{}` — a run parked before this column existed recorded
 * nothing, which is precisely what an empty bag says. That is why the default is
 * not null: a nullable column would put `variables ?? {}` at every read site
 * forever to describe a state that stops occurring the moment this runs.
 */
const migration = {
    postgres: {
        up: async (db: Kysely<any>) => {
            await db.schema
                .alterTable('flow_runs')
                .addColumn('variables', 'jsonb', (col) => col.notNull().defaultTo(sql`'{}'::jsonb`))
                .execute();
        },
        down: async (db: Kysely<any>) => {
            await db.schema.alterTable('flow_runs').dropColumn('variables').execute();
        },
    },
    sqlite: {
        up: async (db: Kysely<any>) => {
            await db.schema
                .alterTable('flow_runs')
                .addColumn('variables', 'text', (col) => col.notNull().defaultTo('{}'))
                .execute();
        },
        down: async (db: Kysely<any>) => {
            await db.schema.alterTable('flow_runs').dropColumn('variables').execute();
        },
    },
};
