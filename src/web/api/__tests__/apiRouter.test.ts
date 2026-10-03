import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import type { AppEnv } from '../../types';
import { apiRouter, jsonResponse } from '../openApi';

/*
 * The runtime half of what `apiRouter` promises: route definitions get no handle on the
 * router itself, and the router it returns mounts anywhere. The compile-time half — the
 * narrowed surface and the handler typing — is `apiRouter.test-d.ts`.
 */

const probeRoute = createRoute({
    method: 'get',
    path: '/probe',
    operationId: 'probe',
    responses: {
        200: jsonResponse('A probe answer.', z.object({ ok: z.boolean() })),
    },
});

describe('apiRouter', () => {
    it('hands route definitions something other than the router, so it cannot be narrowed back', () => {
        let handed: unknown;
        const router = apiRouter((routes) => {
            handed = routes;
        });

        expect(handed).not.toBeInstanceOf(OpenAPIHono);
        expect(router).toBeInstanceOf(OpenAPIHono);
    });

    it('mounts on a plain Hono, which serves the route', async () => {
        const app = new Hono<AppEnv>().route(
            '/api',
            apiRouter((routes) => {
                routes.openapi(probeRoute, (c) => c.json({ ok: true }, 200));
            })
        );

        const response = await app.request('/api/probe');

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ ok: true });
    });

    it('mounts on an OpenAPIHono, which describes the route', () => {
        const app = new OpenAPIHono<AppEnv>().route(
            '/api',
            apiRouter((routes) => {
                routes.openapi(probeRoute, (c) => c.json({ ok: true }, 200));
            })
        );

        const document = app.getOpenAPI31Document({ openapi: '3.1.0', info: { title: 'probe', version: '0' } });

        expect(Object.keys(document.paths ?? {})).toEqual(['/api/probe']);
    });
});
