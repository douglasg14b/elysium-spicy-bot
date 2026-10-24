import { z } from '@hono/zod-openapi';
import { IMAGE_CONTENT_TYPES, type GuildUpload, type UploadUse } from '../../features-system/guild-uploads';
import { ErrorBodySchema, type ChecksHold, type MismatchedChecks, type SchemaMatches } from './openApi';

/**
 * One uploaded picture as the dashboard sees it: everything but its bytes, which the
 * browser loads through `GET /api/guilds/{guildId}/uploads/{uploadId}`.
 */
export const GuildUploadSchema = z
    .object({
        uploadId: z.string(),
        fileName: z.string(),
        contentType: z.enum(IMAGE_CONTENT_TYPES),
        byteSize: z.number().int(),
        uploadedBy: z.string(),
        createdAt: z.string(),
    })
    .openapi('GuildUpload', {
        description:
            'A picture kept for this server\'s messages, without its bytes. A flow names it as ' +
            '`upload:<uploadId>`; `contentType` was read from the bytes, not from the file name.',
    });

export type GuildUploadBody = z.infer<typeof GuildUploadSchema>;

/** One place an upload is shown: an `UploadUse` without the upload's id, which its listing already carries. */
export const UploadUseSchema = z
    .object({
        flowId: z.string(),
        flowName: z.string(),
        nodeId: z.string(),
        blockLabel: z.string(),
        where: z.string(),
        draftAuthorId: z.string().optional(),
    })
    .openapi('UploadUse', {
        description:
            'One place a picture is shown: the flow (as a draft names it, when the use is in one), the ' +
            'node, its block\'s label, and the part as the message editor names it (`embed 1 thumbnail`). ' +
            '`draftAuthorId` is set when the use is only in that person\'s unsaved draft.',
    });

export type UploadUseBody = z.infer<typeof UploadUseSchema>;

/**
 * {@link UploadUseSchema} states guild-uploads' `UploadUse`, less the id. Asserted in
 * `__tests__/uploadBody.test-d.ts`; see {@link SchemaMatches}.
 */
type UploadBodyChecks = ChecksHold<{
    UploadUse: SchemaMatches<typeof UploadUseSchema, Omit<UploadUse, 'uploadId'>>;
}>;

/** The checks in {@link UploadBodyChecks} that fail, or `never`. */
export type UploadBodyMismatch = MismatchedChecks<UploadBodyChecks>;

/** One upload in the server's list, with every place it is shown. */
export const GuildUploadListingSchema = GuildUploadSchema.extend({
    uses: z.array(UploadUseSchema),
}).openapi('GuildUploadListing', {
    description:
        'A picture kept for this server\'s messages, without its bytes, and every place a saved flow or a ' +
        'draft shows it — empty when nothing does, so it may be deleted.',
});

/** The server's uploads, and how much of its allowance they take. */
export const GuildUploadListSchema = z
    .object({
        uploads: z.array(GuildUploadListingSchema),
        totalBytes: z.number().int(),
        limitBytes: z.number().int(),
    })
    .openapi('GuildUploadList', {
        description:
            "The server's uploads, newest first; `totalBytes` is their sizes added up, and `limitBytes` " +
            'the most they may add up to.',
    });

export type GuildUploadListBody = z.infer<typeof GuildUploadListSchema>;

/** The 409 a delete is refused with while anything shows the picture. */
export const UploadInUseSchema = ErrorBodySchema.extend({
    uses: z.array(UploadUseSchema),
}).openapi('UploadInUse', {
    description: 'The picture was not deleted: these places still show it. Swap it out of each, then try again.',
});

/** The wire shape of one use; the upload's id is left off, since the listing or refusal names it. */
export function uploadUseBody(use: UploadUse): UploadUseBody {
    const { uploadId: _uploadId, ...body } = use;
    return body;
}

/**
 * The server's list: each upload with its uses — a use naming an upload the server does not
 * hold is dropped — and the total taken, added up from the same rows.
 */
export function guildUploadListBody(
    uploads: readonly GuildUpload[],
    uses: readonly UploadUse[],
    limitBytes: number
): GuildUploadListBody {
    const usesByUpload = new Map<string, UploadUseBody[]>();
    for (const use of uses) {
        const listed = usesByUpload.get(use.uploadId) ?? [];
        listed.push(uploadUseBody(use));
        usesByUpload.set(use.uploadId, listed);
    }
    return {
        uploads: uploads.map((upload) => ({ ...guildUploadBody(upload), uses: usesByUpload.get(upload.uploadId) ?? [] })),
        totalBytes: uploads.reduce((total, upload) => total + upload.byteSize, 0),
        limitBytes,
    };
}

/** The wire shape of one stored upload. */
export function guildUploadBody(upload: GuildUpload): GuildUploadBody {
    return {
        uploadId: upload.uploadId,
        fileName: upload.fileName,
        contentType: upload.contentType,
        byteSize: upload.byteSize,
        uploadedBy: upload.uploadedBy,
        createdAt: new Date(upload.createdAt).toISOString(),
    };
}
