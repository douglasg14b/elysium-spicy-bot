/**
 * Keeping a picture for a server, and keeping the server's cached list of pictures in step —
 * the one upload path, used by the Uploads page and by the flow builder's picture box alike.
 *
 * Both read the same cache entry (`listGuildUploadsQueryKey`), so a picture kept or deleted in
 * one is what the other shows next.
 */

import type { QueryClient } from '@tanstack/react-query';
import {
    ApiError,
    listGuildUploadsQueryKey,
    uploadGuildImage,
    type GuildUpload,
    type ListGuildUploadsResponse,
} from '@brattybot/web-sdk';
import { writeSavedAnswer } from '../api/writeSavedAnswer';
import { UPLOAD_SIZE_BYTES, UPLOAD_SIZE_LABEL } from './uploadLimits';

/**
 * What an upload that never got an answer is told — the network, not the server, said no.
 * A refusal the server sent is shown in the server's own words instead.
 */
const UPLOAD_UNANSWERED_SENTENCE = "That upload didn't make it — check your connection and throw it at me again.";

/**
 * A file over the server's cap, refused before it is sent.
 *
 * The server would refuse it too, from its declared length alone and without reading it — but
 * by then the browser is streaming megabytes at a server that has already answered and may close
 * the connection, and an early 413 can arrive as a connection reset instead of the sentence.
 */
class UploadTooBigError extends Error {
    constructor(fileName: string) {
        super(`${fileName} is a bit too much, even for me. ${UPLOAD_SIZE_LABEL} or less, please.`);
        this.name = 'UploadTooBigError';
    }
}

/** What a failed upload says: the refusal's own words, or that the upload never got an answer. */
export function uploadRefusalSentence(error: unknown): string {
    return error instanceof ApiError || error instanceof UploadTooBigError ? error.message : UPLOAD_UNANSWERED_SENTENCE;
}

/** A picture the server kept, and whether it is new (201) or one it already held (200). */
export interface KeptGuildUpload {
    readonly upload: GuildUpload;
    readonly created: boolean;
}

/**
 * `listed` with `kept` first: a new picture (`created`) used nowhere yet and added to the total,
 * or one the server already held moved up as listed — its uses kept, the total unchanged.
 * `undefined` for one the server already held that this list never had: its uses are the
 * server's to say, so the list is asked for again instead.
 */
export function withKeptFirst(
    listed: ListGuildUploadsResponse,
    kept: GuildUpload,
    created: boolean
): ListGuildUploadsResponse | undefined {
    const others = listed.uploads.filter((upload) => upload.uploadId !== kept.uploadId);
    const existing = listed.uploads.find((upload) => upload.uploadId === kept.uploadId);
    if (created) {
        // Already there when a read that ran after the server kept it landed first: counted once.
        const added = existing ? 0 : kept.byteSize;
        return { ...listed, uploads: [{ ...kept, uses: [] }, ...others], totalBytes: listed.totalBytes + added };
    }
    return existing ? { ...listed, uploads: [existing, ...others] } : undefined;
}

/** `listed` with `uploadId` taken out and its bytes off the total; as it was when it lacks it. */
export function withoutUpload(listed: ListGuildUploadsResponse, uploadId: string): ListGuildUploadsResponse {
    const gone = listed.uploads.find((upload) => upload.uploadId === uploadId);
    return gone
        ? { ...listed, uploads: listed.uploads.filter((upload) => upload !== gone), totalBytes: listed.totalBytes - gone.byteSize }
        : listed;
}

/**
 * Keep `file` for `guildId`, and put it at the top of the server's cached list. Throws a file
 * over the cap without sending it, and the server's refusal (`ApiError`) — not a picture, or the
 * server full. {@link uploadRefusalSentence} words either.
 */
export async function keepGuildUpload(queryClient: QueryClient, guildId: string, file: File): Promise<KeptGuildUpload> {
    if (file.size > UPLOAD_SIZE_BYTES) {
        throw new UploadTooBigError(file.name);
    }
    const scope = { path: { guildId } };
    const { data: kept, response } = await uploadGuildImage({ ...scope, query: { name: file.name }, body: file });
    // 201 is a new picture; 200 is one the server already held.
    const created = response.status === 201;
    const queryKey = listGuildUploadsQueryKey(scope);
    let patched = false;
    // Against the list as it stands once any read in flight is cancelled, not a copy taken earlier.
    await writeSavedAnswer<ListGuildUploadsResponse | undefined>(queryClient, queryKey, (listed) => {
        const next = listed && withKeptFirst(listed, kept, created);
        patched = !!next;
        return next ?? listed;
    });
    if (!patched) {
        // Nothing listed yet, or a picture this list never had: ask for the list instead.
        void queryClient.invalidateQueries({ queryKey });
    }
    return { upload: kept, created };
}
