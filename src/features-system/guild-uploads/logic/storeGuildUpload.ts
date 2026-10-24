import { createHash } from 'node:crypto';
import { GUILD_UPLOAD_TOTAL_LIMIT_BYTES, UPLOAD_FILE_NAME_MAX_LENGTH } from '../constants';
import { guildUploadsRepo, type GuildUpload } from '../data/guildUploadsRepo';
import { detectImageType, IMAGE_EXTENSIONS, type ImageContentType } from './detectImageType';
import { oneAtATimePerGuild } from './oneAtATimePerGuild';

/** One picture someone sent, as the route read it. */
export interface StoreGuildUploadInput {
    readonly guildId: string;
    readonly bytes: Buffer;
    /** The name the uploader's file had, as sent; absent when they sent none. */
    readonly requestedName: string | undefined;
    readonly uploadedBy: string;
}

/** What became of a picture someone sent. */
export type StoreGuildUploadOutcome =
    | { readonly kind: 'created'; readonly upload: GuildUpload }
    /** The guild already held these exact bytes; nothing new was stored. */
    | { readonly kind: 'existing'; readonly upload: GuildUpload }
    | { readonly kind: 'notAnImage' }
    /** Storing it would take the guild past {@link GUILD_UPLOAD_TOTAL_LIMIT_BYTES}. */
    | { readonly kind: 'overGuildLimit' };

/**
 * Control and invisible formatting characters, which a display name has no use for: the
 * formatting ones include bidi overrides, which can make `photo‮gnp.exe` read as
 * `photoexe.png`.
 */
const CONTROL_CHARACTERS = /[\p{Cc}\p{Cf}]/gu;

/**
 * The name an upload is shown under: the last segment of whatever path the browser sent,
 * with whitespace runs collapsed to one space, control and formatting characters gone, trimmed, and cut to
 * {@link UPLOAD_FILE_NAME_MAX_LENGTH} characters (by code point, so no emoji is split in
 * half). A picture sent with no usable name — a paste from the clipboard, say — is shown as
 * `image.<extension>` of its sniffed type.
 */
function uploadDisplayName(requestedName: string | undefined, contentType: ImageContentType): string {
    const lastSegment = (requestedName ?? '').split(/[\\/]/).pop() ?? '';
    // Whitespace first, so a tab or newline becomes a space before the other controls go.
    const cleaned = lastSegment.replace(/\s+/g, ' ').replace(CONTROL_CHARACTERS, '').trim();
    const name = [...cleaned].slice(0, UPLOAD_FILE_NAME_MAX_LENGTH).join('').trim();
    return name || `image.${IMAGE_EXTENSIONS[contentType]}`;
}

/**
 * Keep a picture for a guild: judge its type by its bytes, find it again if the guild
 * already has the same bytes, and otherwise store it while the guild has room.
 *
 * A re-upload is answered with the row already held even when the guild is at its limit,
 * since it adds nothing.
 *
 * The lookup, the limit check and the insert run as one step per guild, on the queue a
 * delete shares ({@link oneAtATimePerGuild}). Without that, uploads racing each other would all read the same total before
 * any of them inserted, and enough of them at once could take a server far past its limit.
 * A database transaction would not do it portably: on Postgres each statement reads its own
 * snapshot, so the sum-then-insert would still race without a lock that SQLite has no
 * equivalent for.
 */
export async function storeGuildUpload(input: StoreGuildUploadInput): Promise<StoreGuildUploadOutcome> {
    const contentType = detectImageType(input.bytes);
    if (!contentType) return { kind: 'notAnImage' };

    const sha256 = createHash('sha256').update(input.bytes).digest('hex');

    return oneAtATimePerGuild(input.guildId, async (): Promise<StoreGuildUploadOutcome> => {
        const existing = await guildUploadsRepo.findByHash(input.guildId, sha256);
        if (existing) return { kind: 'existing', upload: existing };

        const usedBytes = await guildUploadsRepo.totalBytesForGuild(input.guildId);
        if (usedBytes + input.bytes.length > GUILD_UPLOAD_TOTAL_LIMIT_BYTES) {
            return { kind: 'overGuildLimit' };
        }

        const { upload, created } = await guildUploadsRepo.create({
            guildId: input.guildId,
            fileName: uploadDisplayName(input.requestedName, contentType),
            contentType,
            sha256,
            bytes: input.bytes,
            uploadedBy: input.uploadedBy,
        });
        return created ? { kind: 'created', upload } : { kind: 'existing', upload };
    });
}
