import { resolve } from 'path';
import { fileURLToPath } from 'url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp, CLIENT_BUILD_DIR } from '../server';

/*
 * `/api/health` stood in for by a route that throws, the way one does on a stored row that
 * will not parse. Public, so the request reaches it without a session. Built with the real
 * `apiRouter`, so its own `onError` rethrows to the root exactly as every route's does.
 */
vi.mock('../api/healthRoutes', async () => {
    const { createRoute } = await import('@hono/zod-openapi');
    const { apiRouter, jsonResponse, ErrorBodySchema } = await import('../api/openApi');
    const throwingRoute = createRoute({
        method: 'get',
        path: '/',
        responses: { 200: jsonResponse('Never sent.', ErrorBodySchema) },
    });
    return {
        healthRoutes: () =>
            apiRouter((router) => {
                router.openapi(throwingRoute, () => {
                    throw new Error('the journey row for secret-dungeon would not parse');
                });
            }),
    };
});

/*
 * The session check made to throw on one path, the way a middleware does when a lookup
 * behind it fails. A middleware throw never passes through a router's own `onError`, which
 * is why the root app owns the answer. Every other path keeps the real check.
 */
vi.mock('../auth/middleware', async (importOriginal) => {
    const original = await importOriginal<typeof import('../auth/middleware')>();
    const { createMiddleware } = await import('hono/factory');
    return {
        ...original,
        requireAuth: createMiddleware(async (c, next) => {
            if (c.req.path.endsWith('/session-lookup-explodes')) {
                throw new Error('the session store went away');
            }
            return original.requireAuth(c, next);
        }),
    };
});

afterEach(() => {
    vi.restoreAllMocks();
});

/**
 * What the whole web app answers for an `/api` path no route serves, and for one that
 * throws.
 *
 * The dashboard's SDK parses every answer as JSON, so an unmounted API path has to be a
 * JSON 404 — not the SPA's `index.html` with a 200, which is what the static fallback gave
 * it before. Tests run without a client build, so this exercises the development branch of
 * `buildApp`; in production the same catch-all is registered before the static fallback,
 * and Hono answers with the first handler registered that responds.
 */
describe('buildApp', () => {
    it('answers an unknown /api path with a JSON 404', async () => {
        const response = await buildApp().request('/api/no-such-thing');

        expect(response.status).toBe(404);
        expect(response.headers.get('Content-Type')).toContain('application/json');
        expect(await response.json()).toEqual({ error: 'Nothing lives at this API path.' });
    });

    it('still asks for a session first on an unknown path under a guild', async () => {
        // The catch-all comes after the API, so the auth middleware in front of every guild
        // route still answers first: an unknown path tells a stranger nothing.
        const response = await buildApp().request('/api/guilds/900000000000000001/no-such-thing');

        expect(response.status).toBe(401);
        expect(await response.json()).toEqual({ error: 'Not authenticated' });
    });

    it('answers a route that throws with the 500 every route declares, and logs what threw', async () => {
        const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);

        const response = await buildApp().request('/api/health');

        expect(response.status).toBe(500);
        expect(response.headers.get('Content-Type')).toContain('application/json');
        // The fixed sentence, and nothing of the failure: that stays in the server's log.
        expect(await response.json()).toEqual({
            error: 'Something broke on our side — not your fault, for once. Try again in a moment.',
        });
        expect(logged).toHaveBeenCalledWith(
            '[web] GET /api/health failed:',
            expect.objectContaining({ message: 'the journey row for secret-dungeon would not parse' })
        );
    });

    it('answers a middleware that throws the same way', async () => {
        const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);

        const response = await buildApp().request('/api/guilds/900000000000000001/session-lookup-explodes');

        expect(response.status).toBe(500);
        expect(await response.json()).toEqual({
            error: 'Something broke on our side — not your fault, for once. Try again in a moment.',
        });
        expect(logged).toHaveBeenCalledWith(
            '[web] GET /api/guilds/900000000000000001/session-lookup-explodes failed:',
            expect.objectContaining({ message: 'the session store went away' })
        );
    });
});

/**
 * What the app does behind Cloudflare. The edge redirects plain HTTP, so these are the app's
 * own answer if that zone setting is ever switched off — see `edgeGuards.ts`.
 */
describe('buildApp behind Cloudflare', () => {
    it.each([
        ['CF-Visitor', '{"scheme":"http"}'],
        ['X-Forwarded-Proto', 'http'],
        ['X-Forwarded-Proto', 'https, http'],
    ])('refuses a request whose %s says it arrived over plain HTTP', async (header, value) => {
        const response = await buildApp().request('/api/no-such-thing', { headers: { [header]: value } });

        expect(response.status).toBe(403);
    });

    it('serves a request that arrived over HTTPS', async () => {
        const response = await buildApp().request('/api/no-such-thing', {
            headers: { 'CF-Visitor': '{"scheme":"https"}', 'X-Forwarded-Proto': 'https' },
        });

        expect(response.status).toBe(404);
    });

    it('marks every API answer as never cacheable, refusals and failures included', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const app = buildApp();

        for (const path of ['/api/no-such-thing', '/api/guilds', '/api/health']) {
            const response = await app.request(path);
            expect(response.headers.get('Cache-Control'), path).toBe('private, no-store');
        }
    });

    it('serves the dashboard from where Vite builds it', async () => {
        const { default: viteConfig } = await import('../../../web/vite.config');
        const webRoot = resolve(fileURLToPath(import.meta.url), '../../../../web');

        expect(CLIENT_BUILD_DIR).toBe(resolve(webRoot, viteConfig.build?.outDir ?? 'missing'));
    });
});
