import { Kysely } from 'kysely';
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
            await db.schema.alterTable('birthdays').addColumn('last_announced_at', 'timestamptz').execute();
        },
        down: async (db: Kysely<any>) => {
            await db.schema.alterTable('birthdays').dropColumn('last_announced_at').execute();
        },
    },
    sqlite: {
        up: async (db: Kysely<any>) => {
            await db.schema.alterTable('birthdays').addColumn('last_announced_at', 'text').execute();
        },
        down: async (db: Kysely<any>) => {
            await db.schema.alterTable('birthdays').dropColumn('last_announced_at').execute();
        },
    },
};
