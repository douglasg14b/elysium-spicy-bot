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
                .alterTable('leveling_progress')
                .addColumn('voice_session_count', 'integer', (col) => col.notNull().defaultTo(0))
                .execute();
            await db.schema
                .alterTable('leveling_progress')
                .addColumn('total_voice_seconds', 'integer', (col) => col.notNull().defaultTo(0))
                .execute();
            await db.schema.alterTable('leveling_progress').addColumn('last_voice_xp_at', 'timestamptz').execute();

            await db.schema
                .alterTable('leveling_activity_events')
                .addColumn('voice_eligible_seconds', 'integer')
                .execute();
            await db.schema
                .alterTable('leveling_activity_events')
                .addColumn('voice_session_started_at', 'timestamptz')
                .execute();
            await db.schema
                .alterTable('leveling_activity_events')
                .addColumn('voice_session_ended_at', 'timestamptz')
                .execute();
            await db.schema.alterTable('leveling_activity_events').addColumn('voice_channel_id', 'text').execute();
            await db.schema
                .alterTable('leveling_activity_events')
                .addColumn('voice_eligibility_rule', 'text')
                .execute();

            await db.schema
                .createTable('leveling_voice_sessions')
                .addColumn('id', 'serial', (col) => col.primaryKey())
                .addColumn('guild_id', 'text', (col) => col.notNull())
                .addColumn('user_id', 'text', (col) => col.notNull())
                .addColumn('channel_id', 'text', (col) => col.notNull())
                .addColumn('session_started_at', 'timestamptz', (col) => col.notNull())
                .addColumn('eligible_accumulator_ms', 'integer', (col) => col.notNull().defaultTo(0))
                .addColumn('eligible_since', 'timestamptz')
                .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
                .execute();

            await db.schema
                .createIndex('leveling_voice_sessions_guild_user_unique_idx')
                .on('leveling_voice_sessions')
                .columns(['guild_id', 'user_id'])
                .unique()
                .execute();
            await db.schema
                .createIndex('leveling_voice_sessions_guild_channel_idx')
                .on('leveling_voice_sessions')
                .columns(['guild_id', 'channel_id'])
                .execute();
        },
        down: async (db: Kysely<any>) => {
            await db.schema.dropTable('leveling_voice_sessions').ifExists().execute();
            await db.schema.alterTable('leveling_activity_events').dropColumn('voice_eligibility_rule').execute();
            await db.schema.alterTable('leveling_activity_events').dropColumn('voice_channel_id').execute();
            await db.schema.alterTable('leveling_activity_events').dropColumn('voice_session_ended_at').execute();
            await db.schema.alterTable('leveling_activity_events').dropColumn('voice_session_started_at').execute();
            await db.schema.alterTable('leveling_activity_events').dropColumn('voice_eligible_seconds').execute();
            await db.schema.alterTable('leveling_progress').dropColumn('last_voice_xp_at').execute();
            await db.schema.alterTable('leveling_progress').dropColumn('total_voice_seconds').execute();
            await db.schema.alterTable('leveling_progress').dropColumn('voice_session_count').execute();
        },
    },
    sqlite: {
        up: async (db: Kysely<any>) => {
            await db.schema
                .alterTable('leveling_progress')
                .addColumn('voice_session_count', 'integer', (col) => col.notNull().defaultTo(0))
                .execute();
            await db.schema
                .alterTable('leveling_progress')
                .addColumn('total_voice_seconds', 'integer', (col) => col.notNull().defaultTo(0))
                .execute();
            await db.schema.alterTable('leveling_progress').addColumn('last_voice_xp_at', 'text').execute();

            await db.schema
                .alterTable('leveling_activity_events')
                .addColumn('voice_eligible_seconds', 'integer')
                .execute();
            await db.schema
                .alterTable('leveling_activity_events')
                .addColumn('voice_session_started_at', 'text')
                .execute();
            await db.schema.alterTable('leveling_activity_events').addColumn('voice_session_ended_at', 'text').execute();
            await db.schema.alterTable('leveling_activity_events').addColumn('voice_channel_id', 'text').execute();
            await db.schema
                .alterTable('leveling_activity_events')
                .addColumn('voice_eligibility_rule', 'text')
                .execute();

            await db.schema
                .createTable('leveling_voice_sessions')
                .addColumn('id', 'integer', (col) => col.primaryKey().autoIncrement())
                .addColumn('guild_id', 'text', (col) => col.notNull())
                .addColumn('user_id', 'text', (col) => col.notNull())
                .addColumn('channel_id', 'text', (col) => col.notNull())
                .addColumn('session_started_at', 'text', (col) => col.notNull())
                .addColumn('eligible_accumulator_ms', 'integer', (col) => col.notNull().defaultTo(0))
                .addColumn('eligible_since', 'text')
                .addColumn('updated_at', 'text', (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
                .execute();

            await db.schema
                .createIndex('leveling_voice_sessions_guild_user_unique_idx')
                .on('leveling_voice_sessions')
                .columns(['guild_id', 'user_id'])
                .unique()
                .execute();
            await db.schema
                .createIndex('leveling_voice_sessions_guild_channel_idx')
                .on('leveling_voice_sessions')
                .columns(['guild_id', 'channel_id'])
                .execute();
        },
        down: async (db: Kysely<any>) => {
            await db.schema.dropTable('leveling_voice_sessions').ifExists().execute();
            await db.schema.alterTable('leveling_activity_events').dropColumn('voice_eligibility_rule').execute();
            await db.schema.alterTable('leveling_activity_events').dropColumn('voice_channel_id').execute();
            await db.schema.alterTable('leveling_activity_events').dropColumn('voice_session_ended_at').execute();
            await db.schema.alterTable('leveling_activity_events').dropColumn('voice_session_started_at').execute();
            await db.schema.alterTable('leveling_activity_events').dropColumn('voice_eligible_seconds').execute();
            await db.schema.alterTable('leveling_progress').dropColumn('last_voice_xp_at').execute();
            await db.schema.alterTable('leveling_progress').dropColumn('total_voice_seconds').execute();
            await db.schema.alterTable('leveling_progress').dropColumn('voice_session_count').execute();
        },
    },
};
