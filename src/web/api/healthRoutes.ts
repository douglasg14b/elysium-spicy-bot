import { createRoute, z, type OpenAPIHono } from '@hono/zod-openapi';
import type { AppEnv } from '../types';
import { apiRouter, jsonResponse } from './openApi';

/** What the liveness probe answers. `time` is the server's clock, as ISO. */
const HealthSchema = z
    .object({
        ok: z.literal(true),
        service: z.literal('brattybot-web'),
        time: z.string(),
    })
    .openapi('Health', { description: "The web server is up. `time` is the server's clock, as ISO." });

const getHealthRoute = createRoute({
    method: 'get',
    path: '/',
    operationId: 'getHealth',
    tags: ['health'],
    summary: 'Whether the web server is up',
    responses: {
        200: jsonResponse('Up.', HealthSchema),
    },
});

/** `/api/health`: public, and touches nothing — not the database, not Discord. */
export function healthRoutes(): OpenAPIHono<AppEnv> {
    return apiRouter((router) => {
        router.openapi(getHealthRoute, (c) =>
            c.json({ ok: true as const, service: 'brattybot-web' as const, time: new Date().toISOString() }, 200)
        );
    });
}
