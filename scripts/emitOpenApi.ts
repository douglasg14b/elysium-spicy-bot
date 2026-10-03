/**
 * Writes the dashboard API's OpenAPI spec to `generated/openapi.generated.json`, the input
 * the SDK in `packages/web-sdk` is generated from. Run with `pnpm openapi:emit`, or as the
 * first half of `pnpm sdk:generate`.
 *
 * Needs no `.env.local`. `src/environment.ts` throws at import when a required variable
 * is missing, and nothing in the spec depends on a real value, so the route tree loads
 * under `stubRequiredEnv.ts` — the same stubs the test suite, and so the drift gate
 * (`openApiSpec.test.ts`), loads it under. The route tree is imported only *after* the
 * stubs are set, hence the dynamic import. Importing it opens no database connection
 * (both dialects connect on first query) and does not log in to Discord.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import '../stubRequiredEnv';

const { buildOpenApiDocument, OPENAPI_SPEC_PATH, serializeOpenApiDocument } = await import(
    '../src/web/api/openApiDocument'
);

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const specPath = resolve(repoRoot, OPENAPI_SPEC_PATH);

mkdirSync(dirname(specPath), { recursive: true });
writeFileSync(specPath, serializeOpenApiDocument(buildOpenApiDocument()));
console.log(`OpenAPI spec written to ${OPENAPI_SPEC_PATH}`);
