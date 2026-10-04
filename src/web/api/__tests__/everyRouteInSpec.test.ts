import { OpenAPIHono } from '@hono/zod-openapi';
import { findTargetHandler } from 'hono/utils/handler';
import { beforeAll, describe, expect, it } from 'vitest';
import { requireAuth, requireGuildAccess } from '../../auth/middleware';
import type { AppEnv } from '../../types';
import { registerApiRoutes } from '../index';
import { buildOpenApiDocument } from '../openApiDocument';

/**
 * The gate behind "a route that works is in the spec": every method + path served under
 * `/api` is described by the OpenAPI spec the dashboard SDK is generated from, or is on
 * {@link NOT_YET_IN_SPEC}.
 *
 * `apiRouter` makes a plain `get`/`post` a compile error inside a converted router, but
 * nothing stops a route being declared on a plain `Hono` router, or on the root in
 * `registerApiRoutes`. Such a route serves requests and the spec never hears of it. This
 * reads what `registerApiRoutes` serves — the function `buildApp` mounts the whole API
 * with — and compares it with the spec built from that same function. A route declared
 * directly in `buildApp` (`src/web/server.ts`) is outside it; `/api` routes do not go there.
 */

/**
 * **A migration bridge, and it must reach zero.** The routes served today that have not
 * been converted to `apiRouter` yet, as `'METHOD /api/path/{param}'`.
 *
 * The gate fails when an entry is no longer served, and when an entry is now in the spec,
 * so converting or deleting a route forces its removal here. {@link NOT_YET_IN_SPEC_CEILING}
 * stops it growing: adding an entry means raising that number too, two deliberate edits a
 * reviewer sees rather than one line that turns the gate green. A new route never goes on
 * this list. Declare it with
 * `apiRouter` (`createRoute` + `router.openapi`) from the start — on an unconverted
 * router too, by giving it its own `apiRouter` mounted at the same prefix, the way
 * `guildRoutes` and `flowRoutes` already share `/api/guilds`. See
 * `.claude/rules/root-cause-over-workarounds.md` — this is the explicit, tracked bridge
 * that rule allows, not a place to park routes.
 */
const NOT_YET_IN_SPEC: readonly string[] = [
    // index.ts (registerApiRoutes itself)
    'GET /api/health',
    // botRoutes.ts
    'GET /api/bot',
    // authRoutes.ts
    'GET /api/auth/login',
    'GET /api/auth/callback',
    'GET /api/auth/me',
    'POST /api/auth/logout',
    // journeyRoutes.ts
    'GET /api/guilds/{guildId}/journeys',
    'GET /api/guilds/{guildId}/journeys/{journeyKey}',
    'GET /api/guilds/{guildId}/journeys/{journeyKey}/published',
    'POST /api/guilds/{guildId}/journeys/{journeyKey}/undeploy',
    'POST /api/guilds/{guildId}/journeys/{journeyKey}/unpublish',
    'GET /api/guilds/{guildId}/journeys/{journeyKey}/drift',
    'POST /api/guilds/{guildId}/journeys/{journeyKey}/repair',
    'POST /api/guilds/{guildId}/journeys/{journeyKey}/orphans/{bindingId}/forget',
    'GET /api/guilds/{guildId}/flows/{flowId}/resources',
    'PUT /api/guilds/{guildId}/flows/{flowId}/resources',
    'GET /api/guilds/{guildId}/flows/{flowId}/attachment',
    'POST /api/guilds/{guildId}/flows/{flowId}/attach',
    'POST /api/guilds/{guildId}/flows/{flowId}/detach',
    'GET /api/guilds/{guildId}/flows/{flowId}/group-preview',
    'POST /api/guilds/{guildId}/flows/{flowId}/group',
    'POST /api/guilds/{guildId}/journeys',
    'PUT /api/guilds/{guildId}/journeys/{journeyKey}',
    'DELETE /api/guilds/{guildId}/journeys/{journeyKey}',
    // levelingRoutes.ts
    'GET /api/guilds/{guildId}/leveling',
    'GET /api/guilds/{guildId}/leveling/users/{userId}',
    'GET /api/guilds/{guildId}/leveling/insights',
    // nodeRoutes.ts
    'GET /api/nodes',
];

/**
 * The most entries {@link NOT_YET_IN_SPEC} may hold. **Lower it as routes convert; never
 * raise it.** The other checks only see entries already on the list, so without this a
 * new, undeclared route plus one line here would pass every gate.
 */
const NOT_YET_IN_SPEC_CEILING = 28;

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

    it('has no served route that is missing from the spec and not on the bridge list', () => {
        const bridged = new Set(NOT_YET_IN_SPEC);
        const undescribed = [...served].filter((key) => !described.has(key) && !bridged.has(key));

        expect(
            undescribed,
            'These routes are served under /api but missing from the OpenAPI spec, so the dashboard SDK ' +
                'cannot see them. Declare each with `apiRouter` (`createRoute` + `router.openapi`; see ' +
                '`guildRoutes.ts`), then run `pnpm sdk:generate`. A new route on an unconverted router ' +
                'goes in its own `apiRouter`, mounted at the same prefix. Do not add them to ' +
                'NOT_YET_IN_SPEC: that list only shrinks. An `ALL` entry is a route declared with `all`/`mount`, or a ' +
                'middleware this test does not know (add it to KNOWN_MIDDLEWARE).'
        ).toEqual([]);
    });

    it('never grows the bridge list', () => {
        // Unique first, so a duplicate cannot hold a slot under the ceiling for a new route.
        expect(new Set(NOT_YET_IN_SPEC).size, 'NOT_YET_IN_SPEC lists a route twice.').toBe(NOT_YET_IN_SPEC.length);
        expect(
            NOT_YET_IN_SPEC.length,
            'NOT_YET_IN_SPEC grew. A new route is declared with `apiRouter`, never added to the list.'
        ).toBeLessThanOrEqual(NOT_YET_IN_SPEC_CEILING);
    });

    it('lists only routes that are still served', () => {
        const gone = NOT_YET_IN_SPEC.filter((key) => !served.has(key));

        expect(gone, 'These NOT_YET_IN_SPEC entries are no longer served. Delete them from the list.').toEqual([]);
    });

    it('lists only routes that are not in the spec yet', () => {
        const converted = NOT_YET_IN_SPEC.filter((key) => described.has(key));

        expect(
            converted,
            'These NOT_YET_IN_SPEC entries are in the spec now. Delete them from the list — it only shrinks.'
        ).toEqual([]);
    });
});
