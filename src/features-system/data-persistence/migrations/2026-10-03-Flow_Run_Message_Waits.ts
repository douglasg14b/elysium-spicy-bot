import { Kysely } from 'kysely';
import { DB_TYPE } from '../../../environment';

export async function up(db: Kysely<any>): Promise<void> {
    await migration[DB_TYPE].up(db);
}

export async function down(db: Kysely<any>): Promise<void> {
    await migration[DB_TYPE].down(db);
}

/**
 * Let a parked run wait for a message.
 *
 * `wait_kind` gains the value `message`, and `wait_config` a shape for it: an optional
 * `channelId` (the channel listened in; absent means anywhere) and a required `parkedAt`
 * (ISO-8601 UTC, where the outage catch-up starts looking for a reply). `wait_kind` is
 * plain `text` and `wait_config` is JSON, so neither needs DDL.
 *
 * **Every arm is deliberately empty**, as in `2026-10-02-Record_Flow_Run_Start.ts`. No
 * stored row changes: every wait parked before this keeps its kind and its config, and
 * reads exactly as it did. `FLOW_RUN_ENTITY_VERSION` moves to 4 for rows written from
 * here on.
 *
 * **Rollback hazard — read before deploying an older build over this one.** An older
 * build's wait-kind enum does not know `message`, and the repo validates every JSON
 * column on read, so a single parked message wait makes `findWaiting` and `findDue`
 * throw for the *whole batch* that row is read in: the scheduler stops resuming every
 * due run, not just that one. Before rolling back, end or cancel every run with
 * `wait_kind = 'message'`, or restore a backup. Running `down` does not help; it is empty
 * for the reason `up` is.
 *
 * **Do not delete this file, and do not make it non-empty.** Once it has run its name
 * is a row in `kysely_migration`, and removing the file strands every database holding
 * that row.
 */
const migration = {
    postgres: {
        up: async (_db: Kysely<any>) => {
            // Intentionally empty — see above. `wait_config` is `jsonb`.
        },
        down: async (_db: Kysely<any>) => {
            // Intentionally empty — nothing was rewritten to reverse. See the rollback hazard above.
        },
    },
    sqlite: {
        up: async (_db: Kysely<any>) => {
            // Intentionally empty — see the postgres arm. `wait_config` is `text` holding JSON.
        },
        down: async (_db: Kysely<any>) => {
            // Intentionally empty — nothing was rewritten to reverse. See the rollback hazard above.
        },
    },
};
