import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildOpenApiDocument, OPENAPI_SPEC_PATH } from '../openApiDocument';

/**
 * The drift gate between the API and the spec the dashboard SDK is generated from.
 *
 * The SDK in `packages/web-sdk` — its types, fetch functions, query helpers and the zod
 * the browser checks a form against — comes from the committed spec, not from the routes.
 * A route changed without re-emitting leaves the dashboard compiling against the API as
 * it was, and nothing else notices: no CI runs here, and the build passes either way.
 *
 * Compared as parsed JSON rather than text, so a checkout that turns line endings into
 * CRLF does not fail it. The SDK is held to this spec by `generatedSdkIsCurrent.test.ts`
 * in `packages/web-sdk`; byte-for-byte, untracked files included, is `pnpm sdk:check`'s job.
 */

/*
 * `sdk:generate`, never `openapi:emit` alone: re-emitting only the spec turns this test
 * green while the SDK the dashboard compiles against still describes the old API.
 */
const REMEDY =
    'The committed OpenAPI spec no longer matches the API routes. Run `pnpm sdk:generate`, ' +
    'which re-emits the spec and regenerates the SDK from it, and commit both.';

/** The refusals `requireAuth` and `requireGuildAccess` give before any guild-scoped route runs. */
const MIDDLEWARE_STATUSES = ['401', '403', '404'] as const;

interface SpecOperation {
    readonly responses?: Record<string, { content?: Record<string, { schema?: { $ref?: string } }> }>;
}

describe('OpenAPI spec drift', () => {
    it('matches the document the routes build', async () => {
        const committed: unknown = JSON.parse(readFileSync(resolve(process.cwd(), OPENAPI_SPEC_PATH), 'utf8'));

        expect(await buildOpenApiDocument(), REMEDY).toEqual(committed);
    });

    /*
     * The middleware sits on the parent, where no route definition can see it, so each
     * guild-scoped route has to declare its refusals itself. One that forgets generates a
     * client that believes the call cannot fail — and compiles, and passes the gate above.
     */
    it('has every guild-scoped operation declare the refusals its middleware gives', async () => {
        const paths = (await buildOpenApiDocument()).paths as Record<string, Record<string, SpecOperation>>;
        const guildScoped = Object.entries(paths).filter(([path]) => path.startsWith('/api/guilds/{guildId}'));
        // A filter that matched nothing would leave nothing missing and pass for no reason.
        expect(guildScoped.length).toBeGreaterThan(0);

        const missing = guildScoped
            .flatMap(([path, operations]) =>
                Object.entries(operations).flatMap(([method, operation]) =>
                    MIDDLEWARE_STATUSES.filter(
                        (status) =>
                            operation.responses?.[status]?.content?.['application/json']?.schema?.$ref !==
                            '#/components/schemas/ErrorBody'
                    ).map((status) => `${method.toUpperCase()} ${path} ${status}`)
                )
            );

        expect(
            missing,
            'Spread `GUILD_SCOPED_ERRORS` (or `GUILD_SCOPED_BODY_ERRORS`) from `openApi.ts` into these routes.'
        ).toEqual([]);
    });

    /*
     * Any route can throw, and the root app answers every throw under `/api` as a 500
     * `ErrorBody` (`server.ts`). `apiRouter` adds the entry to each route it registers; a
     * client generated without it would not know a 500 carries the API's envelope.
     */
    it('has every operation declare the 500 the root error handler answers', async () => {
        const paths = (await buildOpenApiDocument()).paths as Record<string, Record<string, SpecOperation>>;
        const operations = Object.entries(paths).flatMap(([path, byMethod]) =>
            Object.entries(byMethod).map(([method, operation]) => ({ name: `${method.toUpperCase()} ${path}`, operation }))
        );
        // An empty list would leave nothing missing and pass for no reason.
        expect(operations.length).toBeGreaterThan(0);

        const missing = operations
            .filter(
                ({ operation }) =>
                    operation.responses?.['500']?.content?.['application/json']?.schema?.$ref !==
                    '#/components/schemas/ErrorBody'
            )
            .map(({ name }) => name);

        expect(missing, 'Register these routes through `apiRouter`, which declares the 500.').toEqual([]);
    });

    it('keeps a 500 a route declares itself, rather than the generic one', async () => {
        const paths = (await buildOpenApiDocument()).paths as Record<
            string,
            Record<string, { responses?: Record<string, { description?: string }> }>
        >;

        // `GET` one flow answers a designed 500 when the flow's journey cannot be read.
        expect(paths['/api/guilds/{guildId}/flows/{flowId}']?.get?.responses?.['500']?.description).toContain(
            "The flow's journey could not be read"
        );
    });
});
