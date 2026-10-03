import { OpenAPIHono } from '@hono/zod-openapi';
import type { AppEnv } from '../types';
import { registerApiRoutes } from './index';

/** Where the committed spec lives, relative to the repo root. The SDK is generated from it. */
export const OPENAPI_SPEC_PATH = 'generated/openapi.generated.json';

/** The OpenAPI document as `getOpenAPI31Document` builds it. */
export type OpenApiDocument = ReturnType<OpenAPIHono['getOpenAPI31Document']>;

/**
 * The dashboard API's OpenAPI document, built from the real `/api` mount.
 *
 * `registerApiRoutes` onto a fresh app — the same function `buildApp` calls — so the
 * paths carry `/api` exactly as served, and nothing listens, logs in to Discord, or
 * queries the database. Only routers built with `apiRouter` contribute; the rest are not
 * described yet.
 *
 * Keys are sorted at every depth so the committed file, and the SDK generated from it, do
 * not churn when routers are mounted or registered in a different order. The price is
 * that generated types list fields alphabetically rather than as declared. Arrays keep
 * their order — `enum` and `tags` are ordered lists — so reordering a schema's fields
 * still moves its `required` list.
 */
export function buildOpenApiDocument(): OpenApiDocument {
    const app = new OpenAPIHono<AppEnv>();
    registerApiRoutes(app);

    const document = app.getOpenAPI31Document({
        openapi: '3.1.0',
        info: {
            title: 'BrattyBot dashboard API',
            version: '1.0.0',
        },
    });

    return sortKeysDeep(document);
}

/** The document as written to {@link OPENAPI_SPEC_PATH}: four-space JSON plus a trailing newline. */
export function serializeOpenApiDocument(document: OpenApiDocument): string {
    return `${JSON.stringify(document, null, 4)}\n`;
}

/** A copy of `value` with every plain object's keys in sorted order. */
function sortKeysDeep<Value>(value: Value): Value {
    if (Array.isArray(value)) {
        return value.map((item: unknown) => sortKeysDeep(item)) as Value;
    }
    if (value && typeof value === 'object') {
        const entries = Object.entries(value as Record<string, unknown>)
            .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
            .map(([key, entry]) => [key, sortKeysDeep(entry)] as const);
        return Object.fromEntries(entries) as Value;
    }
    return value;
}
