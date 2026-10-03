import { Kysely } from 'kysely';
import { DB_TYPE } from '../../../environment';

export async function up(db: Kysely<any>): Promise<void> {
    await migration[DB_TYPE].up(db);
}

export async function down(db: Kysely<any>): Promise<void> {
    await migration[DB_TYPE].down(db);
}

/**
 * Index "this member in this channel" on `activity_events`.
 *
 * The member's last message in a channel, and whether they said anything there between
 * two instants, were answered from `(guild_id, channel_id, occurred_at)` or its
 * `parent_channel_id` twin, then filtered by member row by row — a walk through a busy
 * channel's whole history on SQLite's one connection. With the member ahead of the time,
 * each lookup seeks straight to that member's rows in that channel, newest or in range.
 *
 * Two, because a channel matches the channel itself and every thread under it, and the
 * repo asks those as two queries so neither dialect plans an `OR` across indexes.
 *
 * `kind` is left out of both on purpose: it is an equality filter applied to the few
 * rows the seek lands on, and reactions are a minority of them. The existing three
 * indexes stay — the guild-wide and anyone-in-a-channel lookups still use them.
 *
 * Sorts after the 2026-10-01 migration that adds `parent_channel_id`.
 */
async function addMemberChannelIndexes(db: Kysely<any>): Promise<void> {
    await db.schema
        .createIndex('activity_events_guild_channel_user_occurred_idx')
        .on('activity_events')
        .columns(['guild_id', 'channel_id', 'user_id', 'occurred_at'])
        .execute();
    await db.schema
        .createIndex('activity_events_guild_parent_channel_user_occurred_idx')
        .on('activity_events')
        .columns(['guild_id', 'parent_channel_id', 'user_id', 'occurred_at'])
        .execute();
}

async function dropMemberChannelIndexes(db: Kysely<any>): Promise<void> {
    await db.schema.dropIndex('activity_events_guild_parent_channel_user_occurred_idx').execute();
    await db.schema.dropIndex('activity_events_guild_channel_user_occurred_idx').execute();
}

const migration = {
    postgres: {
        // Kysely already wraps a postgres migration in a transaction.
        up: addMemberChannelIndexes,
        down: dropMemberChannelIndexes,
    },
    sqlite: {
        /*
         * `SqliteAdapter.supportsTransactionalDdl` is false, so the migrator does not
         * wrap this; two statements need a transaction of their own to be atomic. Every
         * statement goes through `trx` — a query on `db` inside the callback waits on
         * the connection the transaction holds and never returns.
         */
        up: async (db: Kysely<any>) => {
            await db.transaction().execute(async (trx) => {
                await addMemberChannelIndexes(trx);
            });
        },
        down: async (db: Kysely<any>) => {
            await db.transaction().execute(async (trx) => {
                await dropMemberChannelIndexes(trx);
            });
        },
    },
};
