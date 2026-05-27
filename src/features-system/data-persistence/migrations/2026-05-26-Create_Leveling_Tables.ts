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
                .createTable('leveling_config')
                .addColumn('id', 'serial', (col) => col.primaryKey())
                .addColumn('guild_id', 'text', (col) => col.notNull())
                .addColumn('enabled', 'boolean', (col) => col.notNull().defaultTo(true))
                .addColumn('notification_channel_id', 'text', (col) => col.notNull())
                .addColumn('message_xp_min', 'integer', (col) => col.notNull().defaultTo(15))
                .addColumn('message_xp_max', 'integer', (col) => col.notNull().defaultTo(25))
                .addColumn('message_cooldown_ms', 'integer', (col) => col.notNull().defaultTo(20000))
                .addColumn('reaction_xp_min', 'integer', (col) => col.notNull().defaultTo(1))
                .addColumn('reaction_xp_max', 'integer', (col) => col.notNull().defaultTo(2))
                .addColumn('reaction_cooldown_ms', 'integer', (col) => col.notNull().defaultTo(180000))
                .addColumn('reaction_xp_enabled', 'boolean', (col) => col.notNull().defaultTo(true))
                .addColumn('photo_xp_bonus_min', 'integer', (col) => col.notNull().defaultTo(10))
                .addColumn('photo_xp_bonus_max', 'integer', (col) => col.notNull().defaultTo(20))
                .addColumn('photo_bonus_enabled', 'boolean', (col) => col.notNull().defaultTo(true))
                .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
                .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
                .addColumn('config_version', 'integer', (col) => col.notNull().defaultTo(1))
                .execute();

            await db.schema.createIndex('leveling_config_guild_idx').on('leveling_config').column('guild_id').execute();
            await db.schema
                .createIndex('leveling_config_guild_unique_idx')
                .on('leveling_config')
                .column('guild_id')
                .unique()
                .execute();

            await db.schema
                .createTable('leveling_progress')
                .addColumn('id', 'serial', (col) => col.primaryKey())
                .addColumn('guild_id', 'text', (col) => col.notNull())
                .addColumn('user_id', 'text', (col) => col.notNull())
                .addColumn('total_xp', 'integer', (col) => col.notNull().defaultTo(0))
                .addColumn('level', 'integer', (col) => col.notNull().defaultTo(1))
                .addColumn('message_count', 'integer', (col) => col.notNull().defaultTo(0))
                .addColumn('reaction_count', 'integer', (col) => col.notNull().defaultTo(0))
                .addColumn('photo_upload_count', 'integer', (col) => col.notNull().defaultTo(0))
                .addColumn('last_message_xp_at', 'timestamptz')
                .addColumn('last_reaction_xp_at', 'timestamptz')
                .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
                .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
                .execute();

            await db.schema
                .createIndex('leveling_progress_guild_user_idx')
                .on('leveling_progress')
                .columns(['guild_id', 'user_id'])
                .execute();
            await db.schema
                .createIndex('leveling_progress_guild_user_unique_idx')
                .on('leveling_progress')
                .columns(['guild_id', 'user_id'])
                .unique()
                .execute();

            await db.schema
                .createTable('leveling_activity_events')
                .addColumn('id', 'bigserial', (col) => col.primaryKey())
                .addColumn('guild_id', 'text', (col) => col.notNull())
                .addColumn('user_id', 'text', (col) => col.notNull())
                .addColumn('activity_type', 'text', (col) => col.notNull())
                .addColumn('xp_amount', 'integer', (col) => col.notNull())
                .addColumn('message_length', 'integer')
                .addColumn('photo_bonus', 'boolean', (col) => col.notNull().defaultTo(false))
                .addColumn('occurred_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
                .execute();

            await db.schema
                .createIndex('leveling_activity_events_guild_user_occurred_idx')
                .on('leveling_activity_events')
                .columns(['guild_id', 'user_id', 'occurred_at'])
                .execute();
            await db.schema
                .createIndex('leveling_activity_events_guild_occurred_idx')
                .on('leveling_activity_events')
                .columns(['guild_id', 'occurred_at'])
                .execute();
        },
        down: async (db: Kysely<any>) => {
            await db.schema.dropTable('leveling_activity_events').ifExists().execute();
            await db.schema.dropTable('leveling_progress').ifExists().execute();
            await db.schema.dropTable('leveling_config').ifExists().execute();
        },
    },
    sqlite: {
        up: async (db: Kysely<any>) => {
            await db.schema
                .createTable('leveling_config')
                .addColumn('id', 'integer', (col) => col.primaryKey().autoIncrement())
                .addColumn('guild_id', 'text', (col) => col.notNull())
                .addColumn('enabled', 'integer', (col) => col.notNull().defaultTo(1))
                .addColumn('notification_channel_id', 'text', (col) => col.notNull())
                .addColumn('message_xp_min', 'integer', (col) => col.notNull().defaultTo(15))
                .addColumn('message_xp_max', 'integer', (col) => col.notNull().defaultTo(25))
                .addColumn('message_cooldown_ms', 'integer', (col) => col.notNull().defaultTo(20000))
                .addColumn('reaction_xp_min', 'integer', (col) => col.notNull().defaultTo(1))
                .addColumn('reaction_xp_max', 'integer', (col) => col.notNull().defaultTo(2))
                .addColumn('reaction_cooldown_ms', 'integer', (col) => col.notNull().defaultTo(180000))
                .addColumn('reaction_xp_enabled', 'integer', (col) => col.notNull().defaultTo(1))
                .addColumn('photo_xp_bonus_min', 'integer', (col) => col.notNull().defaultTo(10))
                .addColumn('photo_xp_bonus_max', 'integer', (col) => col.notNull().defaultTo(20))
                .addColumn('photo_bonus_enabled', 'integer', (col) => col.notNull().defaultTo(1))
                .addColumn('created_at', 'text', (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
                .addColumn('updated_at', 'text', (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
                .addColumn('config_version', 'integer', (col) => col.notNull().defaultTo(1))
                .execute();

            await db.schema.createIndex('leveling_config_guild_idx').on('leveling_config').column('guild_id').execute();
            await db.schema
                .createIndex('leveling_config_guild_unique_idx')
                .on('leveling_config')
                .column('guild_id')
                .unique()
                .execute();

            await db.schema
                .createTable('leveling_progress')
                .addColumn('id', 'integer', (col) => col.primaryKey().autoIncrement())
                .addColumn('guild_id', 'text', (col) => col.notNull())
                .addColumn('user_id', 'text', (col) => col.notNull())
                .addColumn('total_xp', 'integer', (col) => col.notNull().defaultTo(0))
                .addColumn('level', 'integer', (col) => col.notNull().defaultTo(1))
                .addColumn('message_count', 'integer', (col) => col.notNull().defaultTo(0))
                .addColumn('reaction_count', 'integer', (col) => col.notNull().defaultTo(0))
                .addColumn('photo_upload_count', 'integer', (col) => col.notNull().defaultTo(0))
                .addColumn('last_message_xp_at', 'text')
                .addColumn('last_reaction_xp_at', 'text')
                .addColumn('created_at', 'text', (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
                .addColumn('updated_at', 'text', (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
                .execute();

            await db.schema
                .createIndex('leveling_progress_guild_user_idx')
                .on('leveling_progress')
                .columns(['guild_id', 'user_id'])
                .execute();
            await db.schema
                .createIndex('leveling_progress_guild_user_unique_idx')
                .on('leveling_progress')
                .columns(['guild_id', 'user_id'])
                .unique()
                .execute();

            await db.schema
                .createTable('leveling_activity_events')
                .addColumn('id', 'integer', (col) => col.primaryKey().autoIncrement())
                .addColumn('guild_id', 'text', (col) => col.notNull())
                .addColumn('user_id', 'text', (col) => col.notNull())
                .addColumn('activity_type', 'text', (col) => col.notNull())
                .addColumn('xp_amount', 'integer', (col) => col.notNull())
                .addColumn('message_length', 'integer')
                .addColumn('photo_bonus', 'integer', (col) => col.notNull().defaultTo(0))
                .addColumn('occurred_at', 'text', (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
                .execute();

            await db.schema
                .createIndex('leveling_activity_events_guild_user_occurred_idx')
                .on('leveling_activity_events')
                .columns(['guild_id', 'user_id', 'occurred_at'])
                .execute();
            await db.schema
                .createIndex('leveling_activity_events_guild_occurred_idx')
                .on('leveling_activity_events')
                .columns(['guild_id', 'occurred_at'])
                .execute();
        },
        down: async (db: Kysely<any>) => {
            await db.schema.dropTable('leveling_activity_events').ifExists().execute();
            await db.schema.dropTable('leveling_progress').ifExists().execute();
            await db.schema.dropTable('leveling_config').ifExists().execute();
        },
    },
};
