import type { ImageContentType } from '../../guild-uploads';
import { database, type DatabaseClient } from '../../data-persistence/database';

/** A picture downloaded for an account, ready to keep. */
export interface MemberAvatarDownload {
    readonly userId: string;
    readonly avatarHash: string;
    readonly contentType: ImageContentType;
    readonly bytes: Buffer;
}

/** A stored picture as the dashboard serves it. */
export interface MemberAvatarFile {
    readonly contentType: ImageContentType;
    readonly bytes: Buffer;
}

/** Ids per `IN (…)`, well inside both dialects' limits on bound values. */
const READ_BATCH_SIZE = 500;

/**
 * Persistence for each account's avatar picture. SQL lives here and nowhere else.
 *
 * Written only by the download queue (`memberAvatarDownloads.ts`), which works on one account
 * at a time, so a store or removal never races another for the same account.
 */
export class MemberAvatarsRepo {
    constructor(private readonly db: DatabaseClient = database) {}

    /** The hash of the picture held for each of `userIds` that has one. Never reads the bytes. */
    async storedHashes(userIds: readonly string[]): Promise<Map<string, string>> {
        const hashes = new Map<string, string>();
        for (let offset = 0; offset < userIds.length; offset += READ_BATCH_SIZE) {
            const rows = await this.db
                .selectFrom('member_avatars')
                .select(['userId', 'avatarHash'])
                .where('userId', 'in', userIds.slice(offset, offset + READ_BATCH_SIZE))
                .execute();
            for (const row of rows) hashes.set(row.userId, row.avatarHash);
        }
        return hashes;
    }

    /** Keep a downloaded picture; one already held for the account is replaced. */
    async store(download: MemberAvatarDownload, fetchedAt: Date): Promise<void> {
        const at = fetchedAt.toISOString();
        await this.db
            .insertInto('member_avatars')
            .values({
                userId: download.userId,
                avatarHash: download.avatarHash,
                contentType: download.contentType,
                fetchedAt: at,
                bytes: download.bytes,
            })
            .onConflict((conflict) =>
                conflict.column('userId').doUpdateSet({
                    avatarHash: download.avatarHash,
                    contentType: download.contentType,
                    fetchedAt: at,
                    bytes: download.bytes,
                })
            )
            .execute();
    }

    /** Drop the picture held for an account seen with no avatar set: only the current picture is kept. */
    async remove(userId: string): Promise<void> {
        await this.db.deleteFrom('member_avatars').where('userId', '=', userId).execute();
    }

    /**
     * The picture for `userId` as `guildId` may show it: only when that guild has a
     * `member_names` row for them — a member it saw, or an id its dashboard looked up — with
     * an avatar set, so a server reads no picture of an id it has never recorded. The row's
     * hash is not required to match the picture's: the picture may be a moment newer than the
     * row, and either way it is the account's own.
     */
    async fileFor(guildId: string, userId: string): Promise<MemberAvatarFile | null> {
        const file = await this.db
            .selectFrom('member_avatars')
            .innerJoin('member_names', 'member_names.userId', 'member_avatars.userId')
            .select(['member_avatars.contentType', 'member_avatars.bytes'])
            .where('member_names.guildId', '=', guildId)
            .where('member_names.userId', '=', userId)
            .where('member_names.avatarHash', 'is not', null)
            .executeTakeFirst();
        return file ?? null;
    }
}

export const memberAvatarsRepo = new MemberAvatarsRepo();
