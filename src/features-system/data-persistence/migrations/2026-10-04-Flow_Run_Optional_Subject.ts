import { Kysely } from 'kysely';
import { DB_TYPE } from '../../../environment';

export async function up(db: Kysely<any>): Promise<void> {
    await migration[DB_TYPE].up(db);
}

export async function down(db: Kysely<any>): Promise<void> {
    await migration[DB_TYPE].down(db);
}

/**
 * Let a parked run be about nobody.
 *
 * A trigger that supplies no member starts runs with no subject, and such a run can park.
 * `context_snapshot.userId` is now optional: absent on a run about nobody, and only then —
 * a run about a member who has since left still records their id.
 *
 * **Every arm is deliberately empty**, for the reasons
 * `2026-10-02-Record_Flow_Run_Start.ts` gives for `startedAt`: the key lives inside a JSON
 * column, and every stored snapshot already carries a `userId`, which still reads exactly
 * as it did. Nothing needs rewriting.
 *
 * Existing rows keep their `entity_version`. `FLOW_RUN_ENTITY_VERSION` moves to 6 for rows
 * written from here on: a rolled-back binary's schema requires `userId`, so a row without
 * one would fail every batch it is read in — the version says which build wrote it.
 *
 * **Do not delete this file, and do not make it non-empty.** Once it has run its name is
 * a row in `kysely_migration`, and removing the file strands every database holding that
 * row.
 */
const migration = {
    postgres: {
        up: async (_db: Kysely<any>) => {
            // Intentionally empty — see above. `context_snapshot` is `jsonb`, and an
            // optional key needs no DDL.
        },
        /**
         * Empty for the same reason `up` is: no row was rewritten. A rolled-back build
         * refuses a row with no `userId` on read; only runs parked by a trigger about
         * nobody can hold one.
         */
        down: async (_db: Kysely<any>) => {
            // Intentionally empty — nothing was rewritten to reverse.
        },
    },
    sqlite: {
        up: async (_db: Kysely<any>) => {
            // Intentionally empty — see the postgres arm. `context_snapshot` is `text`
            // holding JSON.
        },
        /** See the postgres arm — same reasoning, same caveats. */
        down: async (_db: Kysely<any>) => {
            // Intentionally empty — nothing was rewritten to reverse.
        },
    },
};
