import { Kysely, sql } from 'kysely';
import { DB_TYPE } from '../../../environment';

export async function up(db: Kysely<any>): Promise<void> {
    await migration[DB_TYPE].up(db);
}

export async function down(db: Kysely<any>): Promise<void> {
    await migration[DB_TYPE].down(db);
}

/**
 * Creates `flow_journey_links`: which journey each flow installs.
 *
 * Until now the answer was a convention — a flow's journey was the one whose key
 * equalled the flow's own id — which can express exactly one flow per journey. A
 * second flow looked itself up, found nothing, and was told it declared no resources.
 * This table is the association made explicit so a journey can hold several flows.
 *
 * The link lives here rather than as `flows.journey_key` because the flow engine's
 * vocabulary gate rejects `journey` inside `flows/data`, and correctly: the
 * interpreter has no concept of a journey. See `flowJourneyLinksSchema.ts` for the
 * full argument, and the `journeys` migration for the same reasoning applied to
 * `created_for_flow_id`.
 *
 * Two indexes, both serving a read that already exists:
 *   - **unique** on `(guild_id, flow_id)` — "one flow has at most one journey", stated
 *     in the schema rather than in prose. It is also what makes the repo's upsert a
 *     move rather than a duplicate;
 *   - a lookup on `(guild_id, journey_key)` — "which flows are attached", which the
 *     journeys page lists and which the delete refusal must have in order to name what
 *     it is protecting.
 *
 * Not foreign keys, for the reason the `journeys` migration records: journey keys are
 * unique per guild rather than globally, so a single-column FK has nothing to point at
 * and a composite one would make sqlite's table-rebuild-on-alter far more fragile.
 */
const migration = {
    postgres: {
        up: async (db: Kysely<any>) => {
            await db.schema
                .createTable('flow_journey_links')
                .addColumn('id', 'serial', (col) => col.primaryKey())
                .addColumn('guild_id', 'text', (col) => col.notNull())
                .addColumn('flow_id', 'text', (col) => col.notNull())
                .addColumn('journey_key', 'text', (col) => col.notNull())
                .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
                .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
                .execute();

            await db.schema
                .createIndex('flow_journey_links_flow_unique_idx')
                .on('flow_journey_links')
                .columns(['guild_id', 'flow_id'])
                .unique()
                .execute();
            await db.schema
                .createIndex('flow_journey_links_guild_journey_idx')
                .on('flow_journey_links')
                .columns(['guild_id', 'journey_key'])
                .execute();

            await backfill(db);
        },
        down: async (db: Kysely<any>) => {
            await db.schema.dropTable('flow_journey_links').ifExists().execute();
        },
    },
    sqlite: {
        up: async (db: Kysely<any>) => {
            await db.schema
                .createTable('flow_journey_links')
                .addColumn('id', 'integer', (col) => col.primaryKey().autoIncrement())
                .addColumn('guild_id', 'text', (col) => col.notNull())
                .addColumn('flow_id', 'text', (col) => col.notNull())
                .addColumn('journey_key', 'text', (col) => col.notNull())
                // ISO-8601 with an explicit `Z` rather than `CURRENT_TIMESTAMP`, matching
                // every other table here: `CURRENT_TIMESTAMP` yields a zoneless
                // space-separated string that V8 parses as *local* time, while the repo
                // writes `toISOString()` UTC. Invisible on a UTC host, wrong elsewhere.
                .addColumn('created_at', 'text', (col) =>
                    col.notNull().defaultTo(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`)
                )
                .addColumn('updated_at', 'text', (col) =>
                    col.notNull().defaultTo(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`)
                )
                .execute();

            await db.schema
                .createIndex('flow_journey_links_flow_unique_idx')
                .on('flow_journey_links')
                .columns(['guild_id', 'flow_id'])
                .unique()
                .execute();
            await db.schema
                .createIndex('flow_journey_links_guild_journey_idx')
                .on('flow_journey_links')
                .columns(['guild_id', 'journey_key'])
                .execute();

            await backfill(db);
        },
        down: async (db: Kysely<any>) => {
            await db.schema.dropTable('flow_journey_links').ifExists().execute();
        },
    },
};

/**
 * Turn today's implicit links into explicit rows.
 *
 * Every journey a flow's resource panel created carries `created_for_flow_id`, and its
 * key is that same flow id. One link row per such journey makes the convention into
 * data **before** anything reads through the new path, so the resolve fallback in the
 * next slice is a bridge for rows written between this migration and the deploy rather
 * than a second permanent resolution rule.
 *
 * Journeys with a null `created_for_flow_id` are standalone — `POST /journeys` writes
 * no owner — and get **no row**. Inventing an attachment for them would be this
 * migration deciding an operator's key collision is an ownership claim, which is
 * exactly the confusion the positive ownership check in `flowJourney()` exists to
 * prevent.
 *
 * Written as an `insert … select` rather than read-then-write: the whole backfill is
 * one statement the database evaluates atomically, so a partially-linked table is not
 * a state this can leave behind.
 *
 * Raw snake_case column names because migrations run on a bare `Kysely<any>` with no
 * `CamelCasePlugin` — the app's client has one, the migrator does not.
 */
async function backfill(db: Kysely<any>): Promise<void> {
    await sql`
        insert into flow_journey_links (guild_id, flow_id, journey_key)
        select guild_id, created_for_flow_id, journey_key
        from journeys
        where created_for_flow_id is not null
    `.execute(db);
}
