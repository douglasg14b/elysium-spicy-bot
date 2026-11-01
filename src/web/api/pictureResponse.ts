import { IMAGE_CONTENT_TYPES } from '../../features-system/guild-uploads';
import { PICTURE_CACHE_CONTROL } from '../edgeGuards';

/**
 * How the API serves a picture's bytes — an uploaded picture (`getGuildUpload`) and a
 * member's kept avatar (`getMemberAvatar`) — so the two answers carry the same headers and
 * the spec describes them the same way.
 */

/**
 * A binary body or response, declared as a plain OpenAPI schema rather than zod. A non-zod
 * schema gets no validator — `@hono/zod-openapi` validates JSON and form bodies only, and a
 * handler reads bytes itself — and the request-rule walk (`requestMessages.ts`) reads JSON
 * bodies only, so there is nothing to walk either.
 */
export const BINARY_SCHEMA = { type: 'string', format: 'binary' } as const;

/**
 * The spec's 200 for a picture. `whyCacheable` says why this route's bytes may be kept for
 * good under its address.
 */
export function pictureResponse(whyCacheable: string) {
    return {
        description: 'The picture.',
        headers: {
            'Cache-Control': {
                description: `Always \`${PICTURE_CACHE_CONTROL}\`: ${whyCacheable} Refusals stay \`private, no-store\`.`,
                schema: { type: 'string' as const, enum: [PICTURE_CACHE_CONTROL] },
            },
            'X-Content-Type-Options': {
                description: 'Always `nosniff`: the picture is only ever what its content type says.',
                schema: { type: 'string' as const, enum: ['nosniff'] },
            },
        },
        content: Object.fromEntries(IMAGE_CONTENT_TYPES.map((contentType) => [contentType, { schema: BINARY_SCHEMA }])),
    };
}

/**
 * The headers a picture is served with: the type its bytes were sniffed as, `nosniff` (as
 * on every response, `dashboardSecureHeaders`, so the answer is safe wherever its router is
 * mounted), and {@link PICTURE_CACHE_CONTROL}, which `noStoreApiResponses` leaves alone.
 */
export function pictureHeaders(contentType: string): Record<string, string> {
    return {
        'Content-Type': contentType,
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': PICTURE_CACHE_CONTROL,
    };
}
