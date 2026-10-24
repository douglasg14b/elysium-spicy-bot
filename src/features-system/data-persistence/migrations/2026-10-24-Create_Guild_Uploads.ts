import { Kysely, sql } from 'kysely';
import { DB_TYPE } from '../../../environment';

export async function up(db: Kysely<any>): Promise<void> {
    await migration[DB_TYPE].up(db);
}

export async function down(db: Kysely<any>): Promise<void> {
    await migration[DB_TYPE].down(db);
}

/**
 * Creates `guild_uploads`: pictures a server's operators uploaded, with their bytes, for
 * flows to attach to the messages they post.
 *
 * `bytes` is `bytea` on postgres and `blob` on sqlite. Both drivers read it back as a
 * `Buffer`. It is the **last column on purpose**: SQLite reads a row's columns in order, so
 * reaching any column after an 8 MiB blob walks the blob's overflow pages, and a metadata
 * list that never names `bytes` would still read every picture (measured: ~190 ms a list at
 * the 200 MiB cap, on the bot's one connection, against ~0.3 ms with the blob last).
 * Postgres stores a large `bytea` out of line, so the order costs it nothing either way.
 *
 * Indexes:
 *  - unique `upload_id`: the id flows name an upload by.
 *  - unique `(guild_id, sha256)`: one row per distinct picture per server, so a re-upload
 *    finds the first and the insert's `ON CONFLICT DO NOTHING` has a target.
 *  - `(guild_id, created_at)`: a server's list, newest first, and its total size.
 */
const migration = {
    postgres: {
        up: async (db: Kysely<any>) => {
            await db.schema
                .createTable('guild_uploads')
                .addColumn('id', 'serial', (col) => col.primaryKey())
                .addColumn('upload_id', 'text', (col) => col.notNull())
                .addColumn('guild_id', 'text', (col) => col.notNull())
                .addColumn('file_name', 'text', (col) => col.notNull())
                .addColumn('content_type', 'text', (col) => col.notNull())
                .addColumn('byte_size', 'integer', (col) => col.notNull())
                .addColumn('sha256', 'text', (col) => col.notNull())
                .addColumn('uploaded_by', 'text', (col) => col.notNull())
                .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
                .addColumn('bytes', 'bytea', (col) => col.notNull())
                .execute();

            await createIndexes(db);
        },
        down: async (db: Kysely<any>) => {
            await db.schema.dropTable('guild_uploads').ifExists().execute();
        },
    },
    sqlite: {
        up: async (db: Kysely<any>) => {
            await db.schema
                .createTable('guild_uploads')
                .addColumn('id', 'integer', (col) => col.primaryKey().autoIncrement())
                .addColumn('upload_id', 'text', (col) => col.notNull())
                .addColumn('guild_id', 'text', (col) => col.notNull())
                .addColumn('file_name', 'text', (col) => col.notNull())
                .addColumn('content_type', 'text', (col) => col.notNull())
                .addColumn('byte_size', 'integer', (col) => col.notNull())
                .addColumn('sha256', 'text', (col) => col.notNull())
                .addColumn('uploaded_by', 'text', (col) => col.notNull())
                // ISO-8601 with an explicit `Z`, matching every other table here:
                // `CURRENT_TIMESTAMP` yields a zoneless string that V8 parses as local time.
                .addColumn('created_at', 'text', (col) =>
                    col.notNull().defaultTo(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`)
                )
                .addColumn('bytes', 'blob', (col) => col.notNull())
                .execute();

            await createIndexes(db);
        },
        down: async (db: Kysely<any>) => {
            await db.schema.dropTable('guild_uploads').ifExists().execute();
        },
    },
};

/** The same three indexes on both dialects. */
async function createIndexes(db: Kysely<any>): Promise<void> {
    await db.schema
        .createIndex('guild_uploads_upload_id_unique_idx')
        .on('guild_uploads')
        .column('upload_id')
        .unique()
        .execute();
    await db.schema
        .createIndex('guild_uploads_guild_sha256_unique_idx')
        .on('guild_uploads')
        .columns(['guild_id', 'sha256'])
        .unique()
        .execute();
    await db.schema
        .createIndex('guild_uploads_guild_created_idx')
        .on('guild_uploads')
        .columns(['guild_id', 'created_at'])
        .execute();
}
