import { Kysely, sql } from 'kysely';
import { DB_TYPE } from '../../../environment';

export async function up(db: Kysely<any>): Promise<void> {
    await migration[DB_TYPE].up(db);
}

export async function down(db: Kysely<any>): Promise<void> {
    await migration[DB_TYPE].down(db);
}

/**
 * Creates `journeys`: the scope a flow's declared resources live in.
 *
 * The flow↔journey association is a column **here**, not on `flows`. An earlier draft
 * added `flows.journey_key` and the flow engine's vocabulary gate rejected it — then
 * rejected `resource_scope_key` too, for `resource` and `scope`. The gate is right,
 * and for a better reason than naming: the interpreter has no concept of a resource,
 * a scope, or a journey. It executes a graph whose node configs already hold ids.
 * Teaching `flows/data` any of those words would specialise the engine toward a use
 * case, which is the one thing that file may not do.
 *
 * Pointing the association the other way costs nothing and keeps the dependency
 * one-directional, the same way `bindResourcesToGraph` lives in `flows/logic` and
 * takes its targets as arguments rather than the engine reaching into provisioning.
 *
 * `created_for_flow_id` is **nullable on purpose**: a journey shared by several flows
 * has no single owner, which is the grouping case deferred to a later step. It records
 * which flow caused the journey to exist, so the builder can show a flow its own
 * declarations without a second table.
 *
 * Deliberately *not* a foreign key constraint. Journey keys are unique per guild, not
 * globally, so a single-column FK has nothing to reference, and a composite FK would
 * make sqlite's table-rebuild-on-alter far more fragile for no enforcement the repo
 * does not already do on write.
 */
const migration = {
    postgres: {
        up: async (db: Kysely<any>) => {
            await db.schema
                .createTable('journeys')
                .addColumn('id', 'serial', (col) => col.primaryKey())
                .addColumn('journey_key', 'text', (col) => col.notNull())
                .addColumn('guild_id', 'text', (col) => col.notNull())
                .addColumn('name', 'text', (col) => col.notNull())
                .addColumn('description', 'text')
                .addColumn('resources', 'jsonb', (col) => col.notNull())
                .addColumn('created_for_flow_id', 'text')
                .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
                .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
                .execute();

            // A journey key identifies a scope *within a guild*. Two guilds may each
            // have `onboarding`, and their resources must not collide.
            await db.schema
                .createIndex('journeys_guild_key_unique_idx')
                .on('journeys')
                .columns(['guild_id', 'journey_key'])
                .unique()
                .execute();
        },
        down: async (db: Kysely<any>) => {
            await db.schema.dropTable('journeys').ifExists().execute();
        },
    },
    sqlite: {
        up: async (db: Kysely<any>) => {
            await db.schema
                .createTable('journeys')
                .addColumn('id', 'integer', (col) => col.primaryKey().autoIncrement())
                .addColumn('journey_key', 'text', (col) => col.notNull())
                .addColumn('guild_id', 'text', (col) => col.notNull())
                .addColumn('name', 'text', (col) => col.notNull())
                .addColumn('description', 'text')
                .addColumn('resources', 'text', (col) => col.notNull())
                .addColumn('created_for_flow_id', 'text')
                // ISO-8601 with an explicit `Z`, matching every other table here:
                // `CURRENT_TIMESTAMP` yields a zoneless space-separated string that V8
                // parses as local time, while the repo writes `toISOString()` UTC.
                .addColumn('created_at', 'text', (col) =>
                    col.notNull().defaultTo(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`)
                )
                .addColumn('updated_at', 'text', (col) =>
                    col.notNull().defaultTo(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`)
                )
                .execute();

            await db.schema
                .createIndex('journeys_guild_key_unique_idx')
                .on('journeys')
                .columns(['guild_id', 'journey_key'])
                .unique()
                .execute();
        },
        down: async (db: Kysely<any>) => {
            await db.schema.dropTable('journeys').ifExists().execute();
        },
    },
};
