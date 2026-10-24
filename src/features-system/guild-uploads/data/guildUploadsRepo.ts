import { randomUUID } from 'node:crypto';
import { database, type DatabaseClient } from '../../data-persistence/database';
import type { ImageContentType } from '../logic/detectImageType';
import type { GuildUploadRow } from './guildUploadsSchema';

/** An upload as everything but its bytes: what a list shows and what a create answers. */
export type GuildUpload = Omit<GuildUploadRow, 'id' | 'bytes'>;

/** One upload's picture, ready to serve or attach. */
export interface GuildUploadBytes {
    readonly contentType: ImageContentType;
    readonly bytes: Buffer;
}

/** One upload's picture with the id it was asked for by, from {@link GuildUploadsRepo.filesFor}. */
export interface GuildUploadFile extends GuildUploadBytes {
    readonly uploadId: string;
}

/** One upload's size, from {@link GuildUploadsRepo.sizesFor}. */
export interface GuildUploadSize {
    readonly uploadId: string;
    readonly byteSize: number;
}

/** A picture to store, already sniffed and hashed. */
export interface NewGuildUploadInput {
    readonly guildId: string;
    readonly fileName: string;
    readonly contentType: ImageContentType;
    readonly sha256: string;
    readonly bytes: Buffer;
    readonly uploadedBy: string;
}

/** What {@link GuildUploadsRepo.create} did: stored a new row, or found the same bytes already there. */
export interface CreatedGuildUpload {
    readonly upload: GuildUpload;
    readonly created: boolean;
}

/**
 * Every column but `id` and `bytes`. Listed rather than `selectAll` so no metadata read can
 * pull the pictures themselves: a server's list could otherwise be 200 MiB.
 */
const METADATA_COLUMNS = [
    'uploadId',
    'guildId',
    'fileName',
    'contentType',
    'byteSize',
    'sha256',
    'uploadedBy',
    'createdAt',
] as const;

/**
 * Persistence for a server's uploaded pictures. SQL lives here and nowhere else.
 *
 * **Every read takes the guild** and matches on it, so an upload id copied from another
 * server's flow finds nothing here — there is no read by upload id alone.
 */
export class GuildUploadsRepo {
    constructor(private readonly db: DatabaseClient = database) {}

    /**
     * Store a picture, or find the one this guild already holds with the same bytes.
     *
     * One insert that does nothing on a `(guild_id, sha256)` clash, then a read of the row
     * either way, so two uploads of the same picture at once both land on the one row
     * rather than one of them failing on the unique index. `created` says whose row it is:
     * only an insert that took writes the id generated here.
     */
    async create(input: NewGuildUploadInput): Promise<CreatedGuildUpload> {
        const uploadId = randomUUID();

        await this.db
            .insertInto('guild_uploads')
            .values({
                uploadId,
                guildId: input.guildId,
                fileName: input.fileName,
                contentType: input.contentType,
                byteSize: input.bytes.length,
                sha256: input.sha256,
                bytes: input.bytes,
                uploadedBy: input.uploadedBy,
                createdAt: new Date().toISOString(),
            })
            .onConflict((conflict) => conflict.columns(['guildId', 'sha256']).doNothing())
            .execute();

        const upload = await this.findByHash(input.guildId, input.sha256);
        if (!upload) {
            throw new Error(
                `Upload insert for guild ${input.guildId} finished but no row holds sha256 ${input.sha256}`
            );
        }
        return { upload, created: upload.uploadId === uploadId };
    }

    /** The upload in this guild with these bytes, by their hex SHA-256, if there is one. */
    async findByHash(guildId: string, sha256: string): Promise<GuildUpload | null> {
        const upload = await this.db
            .selectFrom('guild_uploads')
            .select(METADATA_COLUMNS)
            .where('guildId', '=', guildId)
            .where('sha256', '=', sha256)
            .executeTakeFirst();
        return upload ?? null;
    }

    /** Whether this guild holds an upload with this id. */
    async holds(guildId: string, uploadId: string): Promise<boolean> {
        const upload = await this.db
            .selectFrom('guild_uploads')
            .select('uploadId')
            .where('guildId', '=', guildId)
            .where('uploadId', '=', uploadId)
            .executeTakeFirst();
        return upload !== undefined;
    }

    /** This guild's uploads, newest first, without their bytes. */
    async listForGuild(guildId: string): Promise<GuildUpload[]> {
        return this.db
            .selectFrom('guild_uploads')
            .select(METADATA_COLUMNS)
            .where('guildId', '=', guildId)
            // `id` breaks a tie between two uploads stamped in the same millisecond.
            .orderBy('createdAt', 'desc')
            .orderBy('id', 'desc')
            .execute();
    }

    /** One upload's picture, if this guild holds it. */
    async bytesFor(guildId: string, uploadId: string): Promise<GuildUploadBytes | null> {
        const file = await this.db
            .selectFrom('guild_uploads')
            .select(['contentType', 'bytes'])
            .where('guildId', '=', guildId)
            .where('uploadId', '=', uploadId)
            .executeTakeFirst();
        return file ?? null;
    }

    /** The sizes of those of `uploadIds` this guild holds. An id it does not hold is left out. */
    async sizesFor(guildId: string, uploadIds: readonly string[]): Promise<GuildUploadSize[]> {
        if (uploadIds.length === 0) return [];
        return this.db
            .selectFrom('guild_uploads')
            .select(['uploadId', 'byteSize'])
            .where('guildId', '=', guildId)
            .where('uploadId', 'in', [...uploadIds])
            .execute();
    }

    /** The pictures of those of `uploadIds` this guild holds. An id it does not hold is left out. */
    async filesFor(guildId: string, uploadIds: readonly string[]): Promise<GuildUploadFile[]> {
        if (uploadIds.length === 0) return [];
        return this.db
            .selectFrom('guild_uploads')
            .select(['uploadId', 'contentType', 'bytes'])
            .where('guildId', '=', guildId)
            .where('uploadId', 'in', [...uploadIds])
            .execute();
    }

    /** How many bytes this guild's uploads take up together; `0` for a guild with none. */
    async totalBytesForGuild(guildId: string): Promise<number> {
        const { total } = await this.db
            .selectFrom('guild_uploads')
            .select((eb) => eb.fn.coalesce(eb.fn.sum<number | string>('byteSize'), eb.lit(0)).as('total'))
            .where('guildId', '=', guildId)
            .executeTakeFirstOrThrow();
        // Postgres answers `sum` of an integer column as a `bigint`, which `pg` hands back as
        // a string; sqlite answers a number.
        return Number(total);
    }

    /**
     * Remove one upload, bytes and all — **scoped to the guild**, so an upload id copied from
     * another server reaches nothing. True when a row went.
     */
    async delete(guildId: string, uploadId: string): Promise<boolean> {
        const result = await this.db
            .deleteFrom('guild_uploads')
            .where('guildId', '=', guildId)
            .where('uploadId', '=', uploadId)
            .executeTakeFirst();
        return Number(result.numDeletedRows) > 0;
    }
}

export const guildUploadsRepo = new GuildUploadsRepo();
