import { Kysely } from 'kysely';
import { DB_TYPE } from '../../../environment';

export async function up(db: Kysely<any>): Promise<void> {
    await migration[DB_TYPE].up(db);
}

export async function down(db: Kysely<any>): Promise<void> {
    await migration[DB_TYPE].down(db);
}

/**
 * Let a parked run remember where it was.
 *
 * `context_snapshot` held `{guildId, userId}` — who the run is about, and nothing
 * about where it was happening. So a run that parked in a channel woke up nowhere,
 * and `condition.inChannel` answered "no" every time regardless of the truth. The
 * snapshot now carries an optional `channelId` alongside the two it already had.
 *
 * **Every arm is deliberately empty.** The new key is optional and disjoint from
 * the existing two, so a stored `{guildId, userId}` already reads as a valid
 * widened snapshot meaning "this run recorded no channel" — which is exactly what
 * it is. There is nothing to backfill either: the channel a run parked in before
 * the key existed was never captured, so any value written here would be invented.
 *
 * Existing rows keep `entity_version = 1` on purpose. That number records which
 * contract the *writing* build held, so stamping 2 onto a row an older build wrote
 * would assert something untrue about data nobody re-examined.
 *
 * `FLOW_RUN_ENTITY_VERSION` still moves to 2 for rows written from here on, per
 * `constants.ts`'s stated condition: a rolled-back binary would be handed a key its
 * schema does not declare. It is a marker, not a discriminator — nothing branches
 * on it at read time.
 *
 * **Do not delete this file, and do not make it non-empty.** Once it has run its
 * name is a row in `kysely_migration`, and removing the file strands every database
 * holding that row. An empty `up` is the intended final state, not an unfinished
 * one.
 */
const migration = {
    postgres: {
        up: async (_db: Kysely<any>) => {
            // Intentionally empty — see above. The column already exists and holds
            // `jsonb`; the new key is optional, so every stored row is already a
            // valid v2 snapshot.
        },
        /**
         * Empty for the same reason `up` is: no row was rewritten, so there is
         * nothing to put back.
         *
         * A rollback is survivable rather than clean. `contextSnapshotSchema` is a
         * non-strict `z.object`, so a v1 reader silently *strips* a `channelId`
         * written while v2 was live — it does not throw, and the run still resumes.
         * What it loses is the channel, so those runs answer `inChannel` as though
         * they were nowhere. Restoring a backup is the way back; this is not it.
         */
        down: async (_db: Kysely<any>) => {
            // Intentionally empty — nothing was rewritten to reverse.
        },
    },
    sqlite: {
        up: async (_db: Kysely<any>) => {
            // Intentionally empty — see the postgres arm. `context_snapshot` is
            // `text` holding JSON, and an optional key needs no DDL.
        },
        /** See the postgres arm — same reasoning, same caveats. */
        down: async (_db: Kysely<any>) => {
            // Intentionally empty — nothing was rewritten to reverse.
        },
    },
};
