import {
    messageUploadIds,
    messageUploadProblems,
    type DiscordMessageInput,
    type MessageUploadFile,
    type MessageUploadProblem,
} from '../../../shared/discordMessage';
import { guildUploadsRepo } from '../data/guildUploadsRepo';
import { IMAGE_EXTENSIONS } from './detectImageType';

/** What reading a message's uploads for one guild came to: the files, or why there are none to send. */
export type MessageUploadRead =
    | { readonly ok: true; readonly files: readonly MessageUploadFile[] }
    | { readonly ok: false; readonly problem: MessageUploadProblem };

/**
 * The size of every upload these messages show, held by **this guild only**, keyed by upload
 * id: what `messageUploadProblems` judges a message's uploads by. An upload another server
 * holds, or nobody does, is simply absent — which the rules read as missing. One query for
 * all of them, and none at all when no message shows an upload. Sizes only, never the bytes.
 *
 * The one read behind every "can these uploads go?" — a journey's save, its install plan, and
 * {@link readMessageUploads} before a post or a repair.
 */
export async function uploadSizesFor(guildId: string, messages: readonly DiscordMessageInput[]): Promise<ReadonlyMap<string, number>> {
    const uploadIds = [...new Set(messages.flatMap((message) => messageUploadIds(message)))];
    if (uploadIds.length === 0) return new Map();

    const held = await guildUploadsRepo.sizesFor(guildId, uploadIds);
    return new Map(held.map((upload) => [upload.uploadId, upload.byteSize] as const));
}

/**
 * The uploaded pictures a message names, read for **this guild only** — an upload id copied
 * from another server's flow or journey finds nothing here, and fails by name like a deleted
 * one.
 *
 * Sizes first, judged by the same rules a save is judged by (`messageUploadProblems`), and the
 * bytes only for a message that can go: a missing upload fails naming the first part showing
 * it, and too many uploads, or too many bytes, fail giving the number. No query at all when
 * the message names no upload.
 *
 * Every caller that posts a message reads its uploads here — Post Embed's run, and a message
 * resource's install and repair — and words the problem with its own name for the message.
 */
export async function readMessageUploads(guildId: string, message: DiscordMessageInput): Promise<MessageUploadRead> {
    const uploadIds = messageUploadIds(message);
    if (uploadIds.length === 0) {
        return { ok: true, files: [] };
    }

    const [problem] = messageUploadProblems(message, await uploadSizesFor(guildId, [message]));
    if (problem) {
        return { ok: false, problem };
    }

    const stored = await guildUploadsRepo.filesFor(guildId, uploadIds);
    return {
        ok: true,
        files: stored.map((file) => ({
            uploadId: file.uploadId,
            extension: IMAGE_EXTENSIONS[file.contentType],
            bytes: file.bytes,
        })),
    };
}
