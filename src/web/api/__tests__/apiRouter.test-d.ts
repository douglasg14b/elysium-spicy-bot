import { createRoute, z } from '@hono/zod-openapi';
import { createMiddleware } from 'hono/factory';
import { describe, expectTypeOf, it } from 'vitest';
import { apiRouter, jsonResponse, type ApiRouteRegistrar } from '../openApi';

/*
 * The compile-time half of what `apiRouter` promises: route definitions can only declare
 * routes the spec sees, and the handler typing survives the narrowed surface.
 *
 * A `.test-d.ts` file, so Vitest's typecheck mode (the `node` project in
 * `vitest.config.ts`) checks it as part of `pnpm test`: a failed `expectTypeOf`, or a
 * `@ts-expect-error` left with nothing to expect, fails the run. In a plain `.test.ts`
 * both are inert at run time, and root `tsc` — the only other checker — is not in CI and
 * already reports unrelated errors, so a broken guard here would go unseen. The runtime
 * half is `apiRouter.test.ts`; the backstop for a route that escapes anyway is
 * `everyRouteInSpec.test.ts`.
 */

const probeConfig = {
    method: 'get',
    path: '/probe',
    operationId: 'probe',
    responses: {
        200: jsonResponse('A probe answer.', z.object({ ok: z.boolean() })),
    },
} as const;

const probeRoute = createRoute(probeConfig);
const hiddenRoute = createRoute({ ...probeConfig, hide: true });
const routeWithMiddleware = createRoute({
    ...probeConfig,
    middleware: [createMiddleware(async (_c, next) => next())],
});

describe('apiRouter types', () => {
    it('hands route definitions no way to declare a route the spec would not see', () => {
        // The whole surface, so a member added to it fails here until this test agrees.
        expectTypeOf<keyof ApiRouteRegistrar>().toEqualTypeOf<'openapi'>();
        // `openapi` returns the router on the real object, so chaining from it would be
        // the same escape one call later.
        expectTypeOf<ReturnType<ApiRouteRegistrar['openapi']>>().toEqualTypeOf<void>();

        apiRouter((routes) => {
            // @ts-expect-error -- served, but left out of the spec.
            routes.openapi(hiddenRoute, (c) => c.json({ ok: true }, 200));
            // @ts-expect-error -- route-level middleware's variables would not be typed.
            routes.openapi(routeWithMiddleware, (c) => c.json({ ok: true }, 200));
        });
    });

    it('refuses async route definitions, whose late routes would never be mounted', () => {
        // @ts-expect-error -- a Promise is not `undefined`.
        apiRouter(async (routes) => {
            routes.openapi(probeRoute, (c) => c.json({ ok: true }, 200));
        });
    });

    it('still checks each handler against the responses its route declares', () => {
        apiRouter((routes) => {
            routes.openapi(probeRoute, (c) => c.json({ ok: true }, 200));
            // @ts-expect-error -- a body the route does not declare.
            routes.openapi(probeRoute, (c) => c.json({ ok: 'yes' }, 200));
            // @ts-expect-error -- a status the route does not declare.
            routes.openapi(probeRoute, (c) => c.json({ ok: true }, 201));
        });
    });
});
