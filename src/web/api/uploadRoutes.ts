import { createRoute, z, type OpenAPIHono } from '@hono/zod-openapi';
import {
    deleteGuildUpload,
    GUILD_UPLOAD_TOTAL_LABEL,
    GUILD_UPLOAD_TOTAL_LIMIT_BYTES,
    guildUploadsRepo,
    IMAGE_CONTENT_TYPES,
    storeGuildUpload,
    UPLOAD_SIZE_LABEL,
    uploadUsesForGuild,
} from '../../features-system/guild-uploads';
import type { AppEnv } from '../types';
import { apiRouter, errorBodyResponse, GUILD_SCOPED_ERRORS, GuildPathSchema, jsonResponse } from './openApi';
import {
    GuildUploadListSchema,
    GuildUploadSchema,
    guildUploadBody,
    guildUploadListBody,
    UploadInUseSchema,
    uploadUseBody,
} from './uploadBody';

/** The only content type an upload's body is taken in: the picture's raw bytes. */
const UPLOAD_CONTENT_TYPE = 'application/octet-stream';

/** What a body sent as anything but {@link UPLOAD_CONTENT_TYPE} is told. */
export const UPLOAD_NOT_RAW_BYTES_SENTENCE = `Send me the picture's raw bytes (${UPLOAD_CONTENT_TYPE}), not whatever that was.`;

/** What bytes that are not a picture this server keeps are told. */
export const UPLOAD_NOT_AN_IMAGE_SENTENCE = "PNG, JPG, GIF or WebP only — that's none of them.";

/** What an upload that would take the server past its total is told. */
export const UPLOAD_GUILD_FULL_SENTENCE =
    `That one would stuff this server past ${GUILD_UPLOAD_TOTAL_LABEL} of pictures, and that's all I hold. ` +
    'Delete some you no longer use on the Uploads page to make room.';

/** What a delete of a picture something still shows is told; the uses come with it. */
export const UPLOAD_IN_USE_SENTENCE =
    "Not so fast — that picture's still on display. Swap it out of everywhere below, then I'll let it go.";

/**
 * How long a browser may keep a picture: a year, without asking again. Private, so no shared
 * cache keeps one server's pictures. Only the picture itself carries it.
 */
export const UPLOAD_CACHE_CONTROL = 'private, max-age=31536000, immutable';

/** What a picture that is not there — or is another server's — is told. */
export const UPLOAD_NOT_FOUND_SENTENCE = "That picture isn't in this server.";

/**
 * The binary body and response, declared as a plain OpenAPI schema rather than zod. A
 * non-zod schema gets no validator — `@hono/zod-openapi` validates JSON and form bodies
 * only, and the handler reads the bytes itself — and the request-rule walk
 * (`requestMessages.ts`) reads JSON bodies only, so there is nothing to walk either.
 */
const BINARY_SCHEMA = { type: 'string', format: 'binary' } as const;

/**
 * What `requireAuth` and `requireGuildAccess` answer, and the upload's own refusals. Not
 * {@link GUILD_SCOPED_BODY_ERRORS}: that one's 413 and 415 describe a JSON body under the
 * 1 MiB cap, and this body is neither.
 */
const UPLOAD_ERRORS = {
    ...GUILD_SCOPED_ERRORS,
    400: errorBodyResponse('The `name` was refused, or the server id is missing.'),
    409: errorBodyResponse(`Keeping it would take the server's uploads past ${GUILD_UPLOAD_TOTAL_LABEL}, so it was not kept.`),
    411: errorBodyResponse('The body did not declare its length (`Content-Length`). It was not read.'),
    413: errorBodyResponse(`The picture's declared length was over ${UPLOAD_SIZE_LABEL}. It was not read.`),
    415: errorBodyResponse(
        `The body was not sent as ${UPLOAD_CONTENT_TYPE}, or is not a PNG, JPEG, GIF or WebP picture by its bytes.`
    ),
};

/**
 * The name the uploader's file had. Optional, and not judged here: the handler cleans it for
 * display (`uploadDisplayName`), and a picture sent without one is still kept.
 */
const UploadQuerySchema = z.object({
    name: z.string().optional(),
});

const UploadPathSchema = GuildPathSchema.extend({
    uploadId: z.string(),
});

const uploadGuildImageRoute = createRoute({
    method: 'post',
    path: '/{guildId}/uploads',
    operationId: 'uploadGuildImage',
    tags: ['uploads'],
    summary: "Keep a picture for this server's messages",
    description:
        `The body is the picture's raw bytes, up to ${UPLOAD_SIZE_LABEL}; \`name\` is its file name, for display. ` +
        'Its type is read from the bytes, never from the name. The same bytes uploaded twice to one ' +
        'server are kept once: the second upload answers 200 with the first one.',
    request: {
        params: GuildPathSchema,
        query: UploadQuerySchema,
        body: { required: true, content: { [UPLOAD_CONTENT_TYPE]: { schema: BINARY_SCHEMA } } },
    },
    responses: {
        200: jsonResponse('The server already held these exact bytes; nothing new was kept.', GuildUploadSchema),
        201: jsonResponse('The picture as kept.', GuildUploadSchema),
        ...UPLOAD_ERRORS,
    },
});

const listGuildUploadsRoute = createRoute({
    method: 'get',
    path: '/{guildId}/uploads',
    operationId: 'listGuildUploads',
    tags: ['uploads'],
    summary: "The server's uploaded pictures, newest first",
    request: { params: GuildPathSchema },
    responses: {
        200: jsonResponse(
            "The server's uploads, newest first, without their bytes, each with where it is shown; and how much " +
                'of its allowance they take.',
            GuildUploadListSchema
        ),
        ...GUILD_SCOPED_ERRORS,
    },
});

const deleteGuildUploadRoute = createRoute({
    method: 'delete',
    path: '/{guildId}/uploads/{uploadId}',
    operationId: 'deleteGuildUpload',
    tags: ['uploads'],
    summary: 'Delete an uploaded picture nothing shows',
    description:
        'Refused while any saved flow or draft shows the picture, with every place that does. Messages the ' +
        'bot has already posted keep their copy: Discord holds those, not this server.',
    request: { params: UploadPathSchema },
    responses: {
        204: { description: 'Deleted.' },
        ...GUILD_SCOPED_ERRORS,
        404: errorBodyResponse('The bot is not in this server, or the server holds no upload with this id.'),
        409: jsonResponse('Something still shows the picture, so it was not deleted.', UploadInUseSchema),
    },
});

const getGuildUploadRoute = createRoute({
    method: 'get',
    path: '/{guildId}/uploads/{uploadId}',
    operationId: 'getGuildUpload',
    tags: ['uploads'],
    summary: 'One uploaded picture',
    description:
        'The picture itself, as the content type its bytes were read as, for an `<img src>` on a signed-in ' +
        'page. Not JSON, so not meant for the SDK.',
    request: { params: UploadPathSchema },
    responses: {
        200: {
            description: 'The picture.',
            headers: {
                'Cache-Control': {
                    description:
                        `Always \`${UPLOAD_CACHE_CONTROL}\`: an upload's bytes never change, so the browser ` +
                        'may keep them. Refusals stay `private, no-store`.',
                    schema: { type: 'string', enum: [UPLOAD_CACHE_CONTROL] },
                },
                'X-Content-Type-Options': {
                    description: 'Always `nosniff`: the picture is only ever what its content type says.',
                    schema: { type: 'string', enum: ['nosniff'] },
                },
            },
            content: Object.fromEntries(IMAGE_CONTENT_TYPES.map((contentType) => [contentType, { schema: BINARY_SCHEMA }])),
        },
        ...GUILD_SCOPED_ERRORS,
        404: errorBodyResponse('The bot is not in this server, or the server holds no upload with this id.'),
    },
});

/**
 * A server's uploaded pictures: keep one, list them, fetch one, delete one nothing shows.
 *
 * Mounted at `/api/guilds` beside the other guild routers, so `requireAuth`, the rate limit
 * and `requireGuildAccess` run first. The upload is the one route whose body may pass 1 MiB
 * (`apiBodyLimit` picks its cap); it and the delete are in the Discord-free budget
 * (`rateLimit.ts`).
 */
export function uploadRoutes(): OpenAPIHono<AppEnv> {
    return apiRouter((router) => {
        /*
         * Keep a picture. Only `application/octet-stream` is taken: it is not a content type a
         * cross-site form can send, so no other site can upload through a signed-in browser.
         */
        router.openapi(uploadGuildImageRoute, async (c) => {
            const contentType = c.req.header('content-type')?.split(';')[0]?.trim().toLowerCase();
            if (contentType !== UPLOAD_CONTENT_TYPE) {
                return c.json({ error: UPLOAD_NOT_RAW_BYTES_SENTENCE }, 415);
            }

            const outcome = await storeGuildUpload({
                guildId: c.get('guild').id,
                bytes: Buffer.from(await c.req.arrayBuffer()),
                requestedName: c.req.valid('query').name,
                uploadedBy: c.get('user').id,
            });

            switch (outcome.kind) {
                case 'created':
                    return c.json(guildUploadBody(outcome.upload), 201);
                case 'existing':
                    return c.json(guildUploadBody(outcome.upload), 200);
                case 'notAnImage':
                    return c.json({ error: UPLOAD_NOT_AN_IMAGE_SENTENCE }, 415);
                case 'overGuildLimit':
                    return c.json({ error: UPLOAD_GUILD_FULL_SENTENCE }, 409);
            }
        });

        /*
         * The list, each upload with its uses: every registered reader's — flows' saved graphs
         * and drafts — read outside any transaction, since SQLite has the one connection.
         */
        router.openapi(listGuildUploadsRoute, async (c) => {
            const guildId = c.get('guild').id;
            const uploads = await guildUploadsRepo.listForGuild(guildId);
            const uses = await uploadUsesForGuild(guildId);
            return c.json(guildUploadListBody(uploads, uses, GUILD_UPLOAD_TOTAL_LIMIT_BYTES), 200);
        });

        /*
         * Delete a picture nothing shows. The use check and the delete run on the queue every
         * upload to the server runs on (`deleteGuildUpload`), and the uses are read again
         * there — the page's list may be out of date.
         */
        router.openapi(deleteGuildUploadRoute, async (c) => {
            const outcome = await deleteGuildUpload(c.get('guild').id, c.req.valid('param').uploadId);
            switch (outcome.kind) {
                case 'deleted':
                    return c.body(null, 204);
                case 'notFound':
                    return c.json({ error: UPLOAD_NOT_FOUND_SENTENCE }, 404);
                case 'inUse':
                    return c.json({ error: UPLOAD_IN_USE_SENTENCE, uses: outcome.uses.map(uploadUseBody) }, 409);
            }
        });

        /*
         * One picture, as the type it was sniffed as. `nosniff` here as well as on every
         * response (`dashboardSecureHeaders`), so the answer is safe wherever this router is
         * mounted.
         *
         * The one `/api` answer a browser may keep ({@link UPLOAD_CACHE_CONTROL}, which
         * `noStoreApiResponses` leaves alone): an upload id names one row whose bytes are
         * never updated, so the editor's pictures need not be fetched again on every render.
         * A refusal sets nothing and stays `no-store`.
         */
        router.openapi(getGuildUploadRoute, async (c) => {
            const { uploadId } = c.req.valid('param');
            const file = await guildUploadsRepo.bytesFor(c.get('guild').id, uploadId);
            if (!file) {
                return c.json({ error: UPLOAD_NOT_FOUND_SENTENCE }, 404);
            }
            // A copy: `c.body` takes a `Uint8Array<ArrayBuffer>`, and a driver's `Buffer` is typed
            // over `ArrayBufferLike`, so a view of it would need a cast to say it is not shared.
            return c.body(new Uint8Array(file.bytes), 200, {
                'Content-Type': file.contentType,
                'X-Content-Type-Options': 'nosniff',
                'Cache-Control': UPLOAD_CACHE_CONTROL,
            });
        });
    });
}
