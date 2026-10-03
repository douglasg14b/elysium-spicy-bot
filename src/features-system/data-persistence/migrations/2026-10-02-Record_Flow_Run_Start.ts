import { Kysely } from 'kysely';
import { DB_TYPE } from '../../../environment';

export async function up(db: Kysely<any>): Promise<void> {
    await migration[DB_TYPE].up(db);
}

export async function down(db: Kysely<any>): Promise<void> {
    await migration[DB_TYPE].down(db);
}

/**
 * Let a parked run remember when it started.
 *
 * `context_snapshot` held who the run is about and where it was, but not when it
 * began — so a resumed run could not answer "how long has this run been going", and
 * the row's own `created_at` is the first park, not the start. The snapshot now
 * carries an optional `startedAt` (ISO-8601 UTC), written once at the first park.
 *
 * **Every arm is deliberately empty**, for the reasons
 * `2026-09-15-Widen_Flow_Run_Context_Snapshot.ts` gives for `channelId`: the key is
 * optional and disjoint from the others, so every stored snapshot already reads as a
 * run that recorded no start time — which is the truth. Nothing can be backfilled
 * either: a parked run's start was never captured, and `created_at` would be a wrong
 * answer dressed as a right one.
 *
 * Existing rows keep their `entity_version`, since that records which contract the
 * writing build held. `FLOW_RUN_ENTITY_VERSION` moves to 3 for rows written from here
 * on: a rolled-back binary's non-strict schema would strip `startedAt` on read.
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
         * `startedAt` on read rather than throwing, so those runs simply report no start
         * time. Restoring a backup is the way back; this is not it.
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
