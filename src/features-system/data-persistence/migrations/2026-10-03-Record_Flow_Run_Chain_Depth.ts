import { Kysely } from 'kysely';
import { DB_TYPE } from '../../../environment';

export async function up(db: Kysely<any>): Promise<void> {
    await migration[DB_TYPE].up(db);
}

export async function down(db: Kysely<any>): Promise<void> {
    await migration[DB_TYPE].down(db);
}

/**
 * Let a parked run remember how deep in a chain of runs it sits.
 *
 * A run started by a ticket change another run made is one deeper than that run, and a
 * start past `FLOW_MAX_CHAIN_DEPTH` is refused — which only holds across a park if the
 * parked run remembers its depth. `context_snapshot` now carries an optional
 * `chainDepth` (a positive whole number), written once at the first park.
 *
 * **Every arm is deliberately empty**, for the reasons
 * `2026-10-02-Record_Flow_Run_Start.ts` gives for `startedAt`: the key is optional and
 * disjoint from the others, so every stored snapshot already reads as depth 1 — which is
 * the truth, because nothing could start a deeper run before this change shipped the
 * Ticket Event trigger.
 *
 * Existing rows keep their `entity_version`. `FLOW_RUN_ENTITY_VERSION` moves to 5 for
 * rows written from here on: a rolled-back binary's non-strict schema would strip
 * `chainDepth` on read, and the runs it resumed would restart their chains at depth 1.
 *
 * **Do not delete this file, and do not make it non-empty.** Once it has run its name
 * is a row in `kysely_migration`, and removing the file strands every database holding
 * that row.
 */
const migration = {
    postgres: {
        up: async (_db: Kysely<any>) => {
            // Intentionally empty — see above. `context_snapshot` is `jsonb`, and an
            // optional key needs no DDL.
        },
        /**
         * Empty for the same reason `up` is: no row was rewritten. A rollback strips
         * `chainDepth` on read rather than throwing, so those runs read as depth 1.
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
