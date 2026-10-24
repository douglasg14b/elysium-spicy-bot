import { guildUploadsRepo } from '../data/guildUploadsRepo';
import { oneAtATimePerGuild } from './oneAtATimePerGuild';
import { uploadUsesForGuild, type UploadUse } from './uploadUsage';

/** What became of a request to delete an upload. */
export type DeleteGuildUploadOutcome =
    | { readonly kind: 'deleted' }
    /** This guild holds no upload with that id — another server's included. */
    | { readonly kind: 'notFound' }
    /** Something still shows it, saved or in a draft; nothing was deleted. */
    | { readonly kind: 'inUse'; readonly uses: readonly UploadUse[] };

/**
 * Delete one of a guild's uploads, unless something still uses it.
 *
 * Whether the guild holds it is asked first, so an id copied from another server is "not
 * here" even when one of this server's flows names it. Then every registered reader is asked
 * for its uses, and a picture anything shows — a draft included — is kept.
 *
 * All of it runs as one step on the queue `storeGuildUpload` uses, so an upload and a delete
 * of the same picture in the same server cannot interleave. Flow saves are not on that queue:
 * a save that read the server's uploads before the delete and writes after it is judged
 * ready, and the gap is accepted. A run of that flow then fails naming the picture as not in
 * this server, and its next save or check reports it on the node.
 */
export async function deleteGuildUpload(guildId: string, uploadId: string): Promise<DeleteGuildUploadOutcome> {
    return oneAtATimePerGuild(guildId, async (): Promise<DeleteGuildUploadOutcome> => {
        if (!(await guildUploadsRepo.holds(guildId, uploadId))) return { kind: 'notFound' };

        const uses = (await uploadUsesForGuild(guildId)).filter((use) => use.uploadId === uploadId);
        if (uses.length > 0) return { kind: 'inUse', uses };

        if (!(await guildUploadsRepo.delete(guildId, uploadId))) {
            // Only this queue deletes uploads, and it found the row a moment ago.
            throw new Error(`Upload ${uploadId} of guild ${guildId} was held, then gone before its delete ran.`);
        }
        return { kind: 'deleted' };
    });
}
