import { Kysely } from 'kysely';
import { DB_TYPE } from '../../../environment';

export async function up(db: Kysely<any>): Promise<void> {
    await migration[DB_TYPE].up(db);
}

export async function down(db: Kysely<any>): Promise<void> {
    await migration[DB_TYPE].down(db);
}

/**
 * Where a journey's message resource was posted, and what it was posted from
 * (`docs/plans/message-resource-step-2.md`, "The binding").
 *
 *  - `message_channel_id`: the channel the message sits in. A message's binding has to
 *    carry it, because uninstall and the orphan list work from binding rows alone, with no
 *    declaration to find the parent channel through — and the parent's key can change.
 *  - `message_digest`: a fingerprint of the declaration the message was posted (or last
 *    repaired) from, which drift compares against.
 *
 * **Nullable text, with no default**, and null on every row that is not a `message`:
 * nothing else has a channel of its own to name or a declaration to fingerprint. Existing
 * rows are left null for the same reason.
 *
 * The two arms are the same statements today; they are written out separately so a
 * dialect-specific change to one cannot silently apply to the other. `down` drops both, as
 * `2026-10-04-Guild_Settings_Time_Zone` does — SQLite has dropped a column since 3.35, and
 * no index names either.
 */
const migration = {
    postgres: {
        up: async (db: Kysely<any>) => {
            await db.schema.alterTable('resource_bindings').addColumn('message_channel_id', 'text').execute();
            await db.schema.alterTable('resource_bindings').addColumn('message_digest', 'text').execute();
        },
        down: async (db: Kysely<any>) => {
            await db.schema.alterTable('resource_bindings').dropColumn('message_digest').execute();
            await db.schema.alterTable('resource_bindings').dropColumn('message_channel_id').execute();
        },
    },
    sqlite: {
        up: async (db: Kysely<any>) => {
            await db.schema.alterTable('resource_bindings').addColumn('message_channel_id', 'text').execute();
            await db.schema.alterTable('resource_bindings').addColumn('message_digest', 'text').execute();
        },
        down: async (db: Kysely<any>) => {
            await db.schema.alterTable('resource_bindings').dropColumn('message_digest').execute();
            await db.schema.alterTable('resource_bindings').dropColumn('message_channel_id').execute();
        },
    },
};
