import { Kysely, sql } from 'kysely';
import { DB_TYPE } from '../../../environment';

export async function up(db: Kysely<any>): Promise<void> {
    await migration[DB_TYPE].up(db);
}

export async function down(db: Kysely<any>): Promise<void> {
    await migration[DB_TYPE].down(db);
}

const migration = {
    postgres: {
        up: async (db: Kysely<any>) => {
            await db.schema
                .createTable('flows')
                .addColumn('id', 'serial', (col) => col.primaryKey())
                .addColumn('flow_id', 'text', (col) => col.notNull())
                .addColumn('guild_id', 'text', (col) => col.notNull())
                .addColumn('name', 'text', (col) => col.notNull())
                .addColumn('enabled', 'boolean', (col) => col.notNull().defaultTo(false))
                .addColumn('graph', 'jsonb', (col) => col.notNull())
                .addColumn('entity_version', 'integer', (col) => col.notNull().defaultTo(1))
                .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
                .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
                .execute();

            await db.schema
                .createIndex('flows_flow_id_unique_idx')
                .on('flows')
                .column('flow_id')
                .unique()
                .execute();

            await db.schema.createIndex('flows_guild_id_idx').on('flows').column('guild_id').execute();
        },
        down: async (db: Kysely<any>) => {
            await db.schema.dropTable('flows').ifExists().execute();
        },
    },
    sqlite: {
        up: async (db: Kysely<any>) => {
            await db.schema
                .createTable('flows')
                .addColumn('id', 'integer', (col) => col.primaryKey().autoIncrement())
                .addColumn('flow_id', 'text', (col) => col.notNull())
                .addColumn('guild_id', 'text', (col) => col.notNull())
                .addColumn('name', 'text', (col) => col.notNull())
                .addColumn('enabled', 'integer', (col) => col.notNull().defaultTo(0))
                .addColumn('graph', 'text', (col) => col.notNull())
                .addColumn('entity_version', 'integer', (col) => col.notNull().defaultTo(1))
                .addColumn('created_at', 'text', (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
                .addColumn('updated_at', 'text', (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
                .execute();

            await db.schema
                .createIndex('flows_flow_id_unique_idx')
                .on('flows')
                .column('flow_id')
                .unique()
                .execute();

            await db.schema.createIndex('flows_guild_id_idx').on('flows').column('guild_id').execute();
        },
        down: async (db: Kysely<any>) => {
            await db.schema.dropTable('flows').ifExists().execute();
        },
    },
};
