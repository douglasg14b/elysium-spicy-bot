import type { ColumnType, Generated } from 'kysely';
import type { ImageContentType } from '../../guild-uploads';

/**
 * Each account's avatar, the picture itself, so a person who left still has one on the
 * dashboard after Discord's link to it stops working (`docs/plans/member-names.md`, step 2).
 *
 * One row per account, shared by every server with a `member_names` row for them: it is the
 * account avatar, not a server one. Only the current picture is kept — a new hash replaces
 * the row. Downloaded in the background (`memberAvatarDownloads.ts`) at 128 px, static.
 *
 * No JSON and no boolean columns, so it is registered with `SqlDatePlugin` alone in
 * `database.ts`. `bytes` is `bytea` on postgres and `blob` on sqlite; both drivers hand back
 * a `Buffer`, and the sqlite binding plugin passes one through untouched.
 */
export interface MemberAvatarsTable {
    id: Generated<number>;
    userId: string;
    /** The hash of the picture held — what the dashboard's `?v=` names. */
    avatarHash: string;
    /** Sniffed from the bytes by `detectImageType`, never taken from the response. */
    contentType: ImageContentType;
    fetchedAt: ColumnType<Date, string, string>;
    bytes: ColumnType<Buffer, Buffer, Buffer>;
}
