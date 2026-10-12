import { OpenAPIHono } from '@hono/zod-openapi';
import { findTargetHandler } from 'hono/utils/handler';
import { beforeAll, describe, expect, it } from 'vitest';
import { requireAuth, requireGuildAccess } from '../../auth/middleware';
import type { AppEnv } from '../../types';
import { registerApiRoutes } from '../index';
import { buildOpenApiDocument } from '../openApiDocument';

/**
 * The gate behind "a route that works is in the spec": every method + path served under
 * `/api` is described by the OpenAPI spec the dashboard SDK is generated from.
 *
 * `apiRouter` makes a plain `get`/`post` a compile error inside a router's route
 * definitions, but nothing stops a route being declared on the router it returns, on a
 * plain `Hono` router, or on the root in `registerApiRoutes`. Such a route serves requests
 * and the spec never hears of it. This reads what `registerApiRoutes` serves — the
 * function `buildApp` mounts the whole API with — and compares it with the spec built from
 * that same function. A route declared directly in `buildApp` (`src/web/server.ts`) is
 * outside it; `/api` routes do not go there.
 *
 * There are no exceptions. The migration that converted the hand-written routes kept a
 * list of the ones still to go; it reached zero and was removed. A route the spec lacks is
 * declared with `apiRouter`, not excused here.
 */

/**
 * The middleware `registerApiRoutes` mounts with `use`, by identity.
 *
 * `app.routes` lists middleware alongside handlers. Hono records a `use` with the method
 * `ALL`, but so are `app.all(...)` and `app.mount(...)` — which serve requests. Dropping
 * every `ALL` entry would therefore also drop a real route declared with `all`, silently.
 * Dropping only the middleware known by identity keeps that case loud: any other `ALL`
 * entry stays in the served set, where it is reported as missing from the spec (no
 * OpenAPI operation can have the method `ALL`). A new middleware fails the gate the same
 * way until it is added here — a one-line, deliberate change.
 *
 * Compared after `findTargetHandler`, because `app.route()` wraps every handler of a
 * sub-router that has its own `onError` — every `apiRouter` does — in a fresh closure,
 * and a middleware `use`d there would otherwise never match.
 */
const KNOWN_MIDDLEWARE: ReadonlySet<unknown> = new Set([requireAuth, requireGuildAccess]);

/** The HTTP methods an OpenAPI path item can hold an operation under. */
const OPERATION_METHODS: ReadonlySet<string> = new Set([
    'get',
    'put',
    'post',
    'delete',
    'options',
    'head',
    'patch',
    'trace',
]);

/** `'METHOD /api/...'`, with Hono's `:param` written the way the spec writes it, `{param}`. */
function operationKey(method: string, path: string): string {
    return `${method.toUpperCase()} ${path.replace(/:([^/]+)/g, '{$1}')}`;
}

/**
 * Every method + path the real app serves under `/api`, once each.
 *
 * A route appears in `app.routes` once per handler in its chain — an `openapi` route once
 * per validator plus its handler, a route with route-level middleware once for each — so
 * the entries are collapsed by method + path.
 */
function servedOperations(): Set<string> {
    const app = new OpenAPIHono<AppEnv>();
    registerApiRoutes(app);

    return new Set(
        app.routes
            .filter((route) => route.path === '/api' || route.path.startsWith('/api/'))
            .filter((route) => !(route.method === 'ALL' && KNOWN_MIDDLEWARE.has(findTargetHandler(route.handler))))
            .map((route) => operationKey(route.method, route.path))
    );
}

/** Every method + path the spec describes. */
async function specOperations(): Promise<Set<string>> {
    const paths = (await buildOpenApiDocument()).paths ?? {};
    return new Set(
        Object.entries(paths).flatMap(([path, item]) =>
            Object.keys(item ?? {})
                .filter((key) => OPERATION_METHODS.has(key))
                .map((method) => operationKey(method, path))
        )
    );
}

describe('every /api route is in the OpenAPI spec', () => {
    let served: Set<string>;
    let described: Set<string>;

    beforeAll(async () => {
        served = servedOperations();
        described = await specOperations();
    });

    it('reads a served set and a spec that both hold the guild routes', () => {
        // Both sides filtered to nothing would leave nothing missing and pass for no reason.
        expect(served.has('GET /api/guilds')).toBe(true);
        expect(described.has('GET /api/guilds')).toBe(true);
    });

    it('has no served route that is missing from the spec', () => {
        const undescribed = [...served].filter((key) => !described.has(key));

        expect(
            undescribed,
            'These routes are served under /api but missing from the OpenAPI spec, so the dashboard SDK ' +
                'cannot see them. Declare each with `apiRouter` (`createRoute` + `router.openapi`; see ' +
                '`guildRoutes.ts`), inside the route definitions rather than on the router `apiRouter` ' +
                'returns, then run `pnpm sdk:generate`. An `ALL` entry is a route declared with ' +
                '`all`/`mount`, or a middleware this test does not know (add it to KNOWN_MIDDLEWARE).'
        ).toEqual([]);
    });
});
