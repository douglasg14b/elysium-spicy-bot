import type { ColumnType, Generated, Selectable } from 'kysely';
import type { ImageContentType } from '../logic/detectImageType';

/**
 * Pictures a server's operators uploaded through the dashboard, kept in the database
 * with their bytes so a flow can attach them to the messages it posts.
 *
 * One row per distinct picture per server: the unique `(guild_id, sha256)` index makes a
 * second upload of the same bytes find the first row rather than store them twice. Every
 * read is scoped to a guild, so a config naming another server's upload id finds nothing.
 *
 * No JSON and no boolean columns, so it is registered with `SqlDatePlugin` alone in
 * `database.ts`. `bytes` is `bytea` on postgres and `blob` on sqlite; both drivers hand
 * back a `Buffer`, and the sqlite binding plugin passes one through untouched.
 */
export interface GuildUploadsTable {
    id: Generated<number>;
    /** The id flows name an upload by (`upload:<uploadId>`): a UUID, unique across servers. */
    uploadId: string;
    guildId: string;
    /** The name the uploader's file had, cleaned for display. Never used to judge the type. */
    fileName: string;
    /** Sniffed from the bytes by `detectImageType`, never taken from the request. */
    contentType: ImageContentType;
    byteSize: number;
    /** Hex SHA-256 of `bytes`, which deduplicates uploads within a server. */
    sha256: string;
    /** Written once and never updated; read only by the queries that need the picture itself. */
    bytes: ColumnType<Buffer, Buffer, never>;
    /** The Discord user id of whoever uploaded it. */
    uploadedBy: string;
    createdAt: ColumnType<Date, string, never>;
}

export type GuildUploadRow = Selectable<GuildUploadsTable>;
