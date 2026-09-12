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
                .createTable('flow_runs')
                .addColumn('id', 'serial', (col) => col.primaryKey())
                .addColumn('run_id', 'text', (col) => col.notNull())
                .addColumn('flow_id', 'text', (col) => col.notNull())
                .addColumn('guild_id', 'text', (col) => col.notNull())
                .addColumn('status', 'text', (col) => col.notNull().defaultTo('pending'))
                .addColumn('resume_node_id', 'text')
                .addColumn('wake_at', 'timestamptz')
                .addColumn('wait_kind', 'text')
                .addColumn('wait_config', 'jsonb')
                .addColumn('context_snapshot', 'jsonb', (col) => col.notNull())
                .addColumn('visits_used', 'integer', (col) => col.notNull().defaultTo(0))
                .addColumn('log', 'jsonb', (col) => col.notNull())
                .addColumn('error', 'text')
                .addColumn('entity_version', 'integer', (col) => col.notNull().defaultTo(1))
                .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
                .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
                .execute();

            await db.schema
                .createIndex('flow_runs_run_id_unique_idx')
                .on('flow_runs')
                .column('run_id')
                .unique()
                .execute();

            await db.schema.createIndex('flow_runs_flow_id_idx').on('flow_runs').column('flow_id').execute();
            await db.schema.createIndex('flow_runs_guild_id_idx').on('flow_runs').column('guild_id').execute();
            await db.schema.createIndex('flow_runs_wake_at_idx').on('flow_runs').column('wake_at').execute();
            await db.schema.createIndex('flow_runs_status_idx').on('flow_runs').column('status').execute();
        },
        down: async (db: Kysely<any>) => {
            await db.schema.dropTable('flow_runs').ifExists().execute();
        },
    },
    sqlite: {
        up: async (db: Kysely<any>) => {
            await db.schema
                .createTable('flow_runs')
                .addColumn('id', 'integer', (col) => col.primaryKey().autoIncrement())
                .addColumn('run_id', 'text', (col) => col.notNull())
                .addColumn('flow_id', 'text', (col) => col.notNull())
                .addColumn('guild_id', 'text', (col) => col.notNull())
                .addColumn('status', 'text', (col) => col.notNull().defaultTo('pending'))
                .addColumn('resume_node_id', 'text')
                .addColumn('wake_at', 'text')
                .addColumn('wait_kind', 'text')
                .addColumn('wait_config', 'text')
                .addColumn('context_snapshot', 'text', (col) => col.notNull())
                .addColumn('visits_used', 'integer', (col) => col.notNull().defaultTo(0))
                .addColumn('log', 'text', (col) => col.notNull())
                .addColumn('error', 'text')
                .addColumn('entity_version', 'integer', (col) => col.notNull().defaultTo(1))
                .addColumn('created_at', 'text', (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
                .addColumn('updated_at', 'text', (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
                .execute();

            await db.schema
                .createIndex('flow_runs_run_id_unique_idx')
                .on('flow_runs')
                .column('run_id')
                .unique()
                .execute();

            await db.schema.createIndex('flow_runs_flow_id_idx').on('flow_runs').column('flow_id').execute();
            await db.schema.createIndex('flow_runs_guild_id_idx').on('flow_runs').column('guild_id').execute();
            await db.schema.createIndex('flow_runs_wake_at_idx').on('flow_runs').column('wake_at').execute();
            await db.schema.createIndex('flow_runs_status_idx').on('flow_runs').column('status').execute();
        },
        down: async (db: Kysely<any>) => {
            await db.schema.dropTable('flow_runs').ifExists().execute();
        },
    },
};
