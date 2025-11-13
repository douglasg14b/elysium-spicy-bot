// 2025-11-10-Create_Ticketing_Config.ts
import { Database } from 'better-sqlite3';
import { Kysely, sql } from 'kysely';
import { DB_TYPE } from '../../../environment';

export async function up(db: Kysely<any>): Promise<void> {
    await ticketingConfig[DB_TYPE].up(db);
}

export async function down(db: Kysely<any>): Promise<void> {
    await ticketingConfig[DB_TYPE].down(db);
}

const ticketingConfig = {
    postgres: {
        up: async (db: Kysely<Database>) => {
            await db.schema
                .createTable('ticketing_config')
                .addColumn('id', 'serial', (col) => col.primaryKey()) // SERIAL -> int + sequence
                .addColumn('guild_id', 'text', (col) => col.notNull())
                .addColumn('config', 'jsonb', (col) => col.notNull())
                .addColumn('ticket_number_inc', 'integer', (col) => col.notNull().defaultTo(0))
                .addColumn('entity_version', 'integer', (col) => col.notNull().defaultTo(1))
                .execute();

            // Create unique index on guild_id since each guild should have only one config
            await db.schema
                .createIndex('tc_guild_id_unique_idx')
                .on('ticketing_config')
                .column('guild_id')
                .unique()
                .execute();
        },

        down: async (db: Kysely<Database>) => {
            await db.schema.dropIndex('tc_guild_id_unique_idx').ifExists().execute();
            await db.schema.dropTable('ticketing_config').ifExists().execute();
        },
    },
    sqlite: {
        up: async (db: Kysely<Database>) => {
            await db.schema
                .createTable('ticketing_config')
                .addColumn('id', 'integer', (col) => col.primaryKey().autoIncrement())
                .addColumn('guild_id', 'text', (col) => col.notNull())
                .addColumn('config', 'text', (col) => col.notNull())
                .addColumn('ticket_number_inc', 'integer', (col) => col.notNull().defaultTo(0))
                .addColumn('entity_version', 'integer', (col) => col.notNull().defaultTo(1))

                // JSON validity constraint for config column
                .addCheckConstraint('tc_config_json_check', sql`json_valid(config)`)

                // Ensure ticket_number_inc is non-negative
                .addCheckConstraint('tc_ticket_number_inc_check', sql`ticket_number_inc >= 0`)

                // Ensure entity_version is positive
                .addCheckConstraint('tc_entity_version_check', sql`entity_version > 0`)
                .execute();

            // Create unique index on guild_id since each guild should have only one config
            await db.schema
                .createIndex('tc_guild_id_unique_idx')
                .on('ticketing_config')
                .column('guild_id')
                .unique()
                .execute();
        },

        down: async (db: Kysely<Database>) => {
            await db.schema.dropIndex('tc_guild_id_unique_idx').ifExists().execute();
            await db.schema.dropTable('ticketing_config').ifExists().execute();
        },
    },
};
