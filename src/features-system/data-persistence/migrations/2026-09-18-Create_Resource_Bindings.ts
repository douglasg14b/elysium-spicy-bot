import { Kysely, sql } from 'kysely';
import { DB_TYPE } from '../../../environment';

export async function up(db: Kysely<any>): Promise<void> {
    await migration[DB_TYPE].up(db);
}

export async function down(db: Kysely<any>): Promise<void> {
    await migration[DB_TYPE].down(db);
}

/**
 * Creates `resource_bindings`, the `(guild, journey, resource) → discordId` map.
 *
 * The table starts empty — provisioning has no prior implementation, so there is
 * nothing to backfill and nothing a wrong postgres arm could damage.
 *
 * One unique index, on the key triple rather than on `discord_id`:
 *   - it is what enforces "a resource key resolves to exactly one binding", which
 *     the whole portability argument rests on;
 *   - it deliberately permits a null `discord_id`, because a row is written in the
 *     `intended` state *before* the guild is mutated. A unique index over the id
 *     would have to special-case that, and would stop two journeys from each having
 *     a pending row.
 *
 * Plus a lookup index on `(guild_id, journey_key)`, which is how install and every
 * subsequent resolve read the table.
 */
const migration = {
    postgres: {
        up: async (db: Kysely<any>) => {
            await db.schema
                .createTable('resource_bindings')
                .addColumn('id', 'serial', (col) => col.primaryKey())
                .addColumn('guild_id', 'text', (col) => col.notNull())
                .addColumn('journey_key', 'text', (col) => col.notNull())
                .addColumn('resource_key', 'text', (col) => col.notNull())
                .addColumn('kind', 'text', (col) => col.notNull())
                .addColumn('state', 'text', (col) => col.notNull())
                .addColumn('discord_id', 'text')
                .addColumn('name', 'text', (col) => col.notNull())
                .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
                .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
                .execute();

            await db.schema
                .createIndex('resource_bindings_key_unique_idx')
                .on('resource_bindings')
                .columns(['guild_id', 'journey_key', 'resource_key'])
                .unique()
                .execute();
            await db.schema
                .createIndex('resource_bindings_guild_journey_idx')
                .on('resource_bindings')
                .columns(['guild_id', 'journey_key'])
                .execute();
        },
        down: async (db: Kysely<any>) => {
            await db.schema.dropTable('resource_bindings').ifExists().execute();
        },
    },
    sqlite: {
        up: async (db: Kysely<any>) => {
            await db.schema
                .createTable('resource_bindings')
                .addColumn('id', 'integer', (col) => col.primaryKey().autoIncrement())
                .addColumn('guild_id', 'text', (col) => col.notNull())
                .addColumn('journey_key', 'text', (col) => col.notNull())
                .addColumn('resource_key', 'text', (col) => col.notNull())
                .addColumn('kind', 'text', (col) => col.notNull())
                .addColumn('state', 'text', (col) => col.notNull())
                .addColumn('discord_id', 'text')
                .addColumn('name', 'text', (col) => col.notNull())
                // ISO-8601 with an explicit `Z` rather than `CURRENT_TIMESTAMP`, which
                // yields a space-separated zoneless string that V8 parses as *local*
                // time while every value the repo writes is `toISOString()` UTC.
                // Invisible on a UTC host, wrong everywhere else.
                .addColumn('created_at', 'text', (col) =>
                    col.notNull().defaultTo(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`)
                )
                .addColumn('updated_at', 'text', (col) =>
                    col.notNull().defaultTo(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`)
                )
                .execute();

            await db.schema
                .createIndex('resource_bindings_key_unique_idx')
                .on('resource_bindings')
                .columns(['guild_id', 'journey_key', 'resource_key'])
                .unique()
                .execute();
            await db.schema
                .createIndex('resource_bindings_guild_journey_idx')
                .on('resource_bindings')
                .columns(['guild_id', 'journey_key'])
                .execute();
        },
        down: async (db: Kysely<any>) => {
            await db.schema.dropTable('resource_bindings').ifExists().execute();
        },
    },
};
