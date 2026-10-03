import { fileURLToPath } from 'node:url';
import { defineConfig, type UserConfig } from '@hey-api/openapi-ts';

/*
 * Generates `src/gen` from the spec the bot's routes emit (`pnpm openapi:emit` at the repo
 * root). Run both with `pnpm sdk:generate`, which `pnpm build` and `pnpm dev` also run;
 * `generatedSdkIsCurrent.test.ts` fails the suite when `src/gen` is not what this config
 * makes of the committed spec. Needs Node 22.18 or later — `@hey-api/openapi-ts`
 * declares it.
 *
 * Operation names come from each route's explicit `operationId`, so adding a route
 * renames nothing that already exists.
 */

/** `path` resolved against this package's directory, so nothing here depends on the cwd. */
function fromPackage(path: string): string {
    return fileURLToPath(new URL(path, import.meta.url));
}

/**
 * The generator's configuration, shared by the `openapi-ts` CLI (through the default
 * export below) and by the stale-SDK test, which regenerates into a temp directory and
 * compares. One object, so the test cannot pass against a config the CLI does not use.
 *
 * Paths are absolute for the same reason. `tsConfigPath` is pinned because the generator
 * otherwise looks for a tsconfig from wherever it writes and picks its import specifiers
 * from what it finds: a temp directory has none, so a regeneration there could disagree
 * with `src/gen` for a reason that has nothing to do with the spec.
 */
export const SDK_GENERATOR_CONFIG = {
    input: fromPackage('../../generated/openapi.generated.json'),
    output: {
        path: fromPackage('src/gen'),
        tsConfigPath: fromPackage('tsconfig.json'),
    },
    plugins: [
        {
            // Every call throws on a refusal — an `ApiError`, via `setupClient`'s
            // interceptor — rather than resolving `{ error }` for each caller to check.
            name: '@hey-api/client-fetch',
            throwOnError: true,
        },
        '@hey-api/sdk',
        {
            name: '@tanstack/react-query',
            queryOptions: true,
            mutationOptions: true,
        },
        {
            // The server's request rules, for the browser to check a form against before
            // sending. Zod 4, the major the server's schemas are written in.
            name: 'zod',
            compatibilityVersion: 4,
        },
    ],
} satisfies UserConfig;

// openapi-ts reads its config from a default export; the one exception to named exports.
export default defineConfig(SDK_GENERATOR_CONFIG);
