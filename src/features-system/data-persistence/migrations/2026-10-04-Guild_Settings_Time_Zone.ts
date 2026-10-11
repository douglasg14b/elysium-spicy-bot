import { Kysely } from 'kysely';
import { DB_TYPE } from '../../../environment';

export async function up(db: Kysely<any>): Promise<void> {
    await migration[DB_TYPE].up(db);
}

export async function down(db: Kysely<any>): Promise<void> {
    await migration[DB_TYPE].down(db);
}

/**
 * Give each server a time zone: `guild_settings.time_zone`, an IANA name.
 *
 * **Nullable, with no default.** Null means the operator has not picked one, and the
 * repo reads it as `DEFAULT_GUILD_TIME_ZONE`. Defaulting the column to that zone would
 * make "picked Pacific" and "never picked" the same stored value, and the dashboard asks
 * for a zone until one is picked — it has to be able to tell the two apart.
 *
 * Existing rows are left null for the same reason: nobody has picked a zone for them.
 *
 * The two arms are the same statement today; they are written out separately so a
 * dialect-specific change to one cannot silently apply to the other.
 */
const migration = {
    postgres: {
        up: async (db: Kysely<any>) => {
            await db.schema.alterTable('guild_settings').addColumn('time_zone', 'text').execute();
        },
        down: async (db: Kysely<any>) => {
            await db.schema.alterTable('guild_settings').dropColumn('time_zone').execute();
        },
    },
    sqlite: {
        up: async (db: Kysely<any>) => {
            await db.schema.alterTable('guild_settings').addColumn('time_zone', 'text').execute();
        },
        down: async (db: Kysely<any>) => {
            await db.schema.alterTable('guild_settings').dropColumn('time_zone').execute();
        },
    },
};
