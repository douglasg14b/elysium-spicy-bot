import { resolve } from 'path';
import { fileURLToPath } from 'url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { API_BODY_LIMIT_BYTES, BODY_TOO_LARGE_SENTENCE } from '../api';
import { DASHBOARD_RATE_LIMITS, dashboardRateLimiter, RATE_LIMITED_SENTENCE } from '../rateLimit';
import { buildApp, CLIENT_BUILD_DIR } from '../server';
import type { AppEnv } from '../types';

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
 * is why the root app owns the answer. A request naming a user in `X-Test-User` is signed in
 * as them, with no guilds, so it reaches the rate limit. Every other path keeps the real check.
 */
vi.mock('../auth/middleware', async (importOriginal) => {
    const original = await importOriginal<typeof import('../auth/middleware')>();
    const { createMiddleware } = await import('hono/factory');
    return {
        ...original,
        requireAuth: createMiddleware<AppEnv>(async (c, next) => {
            if (c.req.path.endsWith('/session-lookup-explodes')) {
                throw new Error('the session store went away');
            }
            // A literal rather than a shared constant: the factory is hoisted above them.
            const testUser = c.req.header('X-Test-User');
            if (testUser) {
                c.set('user', { id: testUser, username: testUser, avatar: null, manageableGuildIds: [] });
                await next();
                return;
            }
            return original.requireAuth(c, next);
        }),
    };
});

afterEach(() => {
    vi.restoreAllMocks();
    dashboardRateLimiter.reset();
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

    it('asks for a session on the bare guild list, which only the /api/guilds/* mount covers', async () => {
        const response = await buildApp().request('/api/guilds');

        expect(response.status).toBe(401);
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

    it.each([
        ['an API refusal', '/api/no-such-thing', {}],
        ['the HTTPS refusal', '/api/no-such-thing', { 'X-Forwarded-Proto': 'http' }],
        ['a page outside the API', '/', {}],
    ])('sends the security headers on %s', async (_label, path, headers) => {
        const response = await buildApp().request(path, { headers });

        expect(response.headers.get('X-Frame-Options')).toBe('DENY');
        expect(response.headers.get('Content-Security-Policy')).toBe("frame-ancestors 'none'");
        expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
        expect(response.headers.get('Strict-Transport-Security')).toContain('max-age=');
        expect(response.headers.get('Referrer-Policy')).toBe('same-origin');
        // Would block the avatars the dashboard loads from Discord's CDN.
        expect(response.headers.get('Cross-Origin-Embedder-Policy')).toBeNull();
    });
});

const GUILD_PATH = '/api/guilds/900000000000000001';

/** The same request `times` times, in order, with each answer's status. */
async function statusesOf(times: number, path: string, init: RequestInit): Promise<number[]> {
    const app = buildApp();
    const statuses: number[] = [];
    for (let request = 0; request < times; request += 1) {
        statuses.push((await app.request(path, init)).status);
    }
    return statuses;
}

/** What the app does with a body too large to take — before it knows who sent it. */
describe('buildApp body limit', () => {
    const flowPath = `${GUILD_PATH}/flows/flow-1`;

    it('refuses a body over the limit with a 413, before asking for a session', async () => {
        const response = await buildApp().request(flowPath, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: 'x'.repeat(API_BODY_LIMIT_BYTES + 1),
        });

        expect(response.status).toBe(413);
        expect(await response.json()).toEqual({ error: BODY_TOO_LARGE_SENTENCE });
    });

    it('refuses on the declared length alone', async () => {
        const response = await buildApp().request(flowPath, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json', 'Content-Length': String(API_BODY_LIMIT_BYTES + 1) },
            body: '{}',
        });

        expect(response.status).toBe(413);
    });

    it('lets a body at the limit through to the session check', async () => {
        const response = await buildApp().request(flowPath, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: 'x'.repeat(API_BODY_LIMIT_BYTES),
        });

        expect(response.status).toBe(401);
    });
});

/**
 * The per-user budgets as the real app mounts them: after the session check, before the
 * guild access check. The signed-in user manages no guild, so every guild-scoped request
 * that gets past the limit is a 403 from that check.
 */
describe('buildApp rate limit', () => {
    const { general, discord } = DASHBOARD_RATE_LIMITS.limits;
    const as = (user: string, method = 'GET'): RequestInit => ({ method, headers: { 'X-Test-User': user } });

    it('counts each guild list request once, and refuses past the general budget', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => undefined);

        const statuses = await statusesOf(general + 1, '/api/guilds', as('alice'));

        expect(statuses.slice(0, general).every((status) => status === 200)).toBe(true);
        expect(statuses[general]).toBe(429);
    });

    it('refuses a Discord-calling route past its budget, before the access check runs', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const app = buildApp();
        const deploy = (): Promise<Response> =>
            Promise.resolve(app.request(`${GUILD_PATH}/flows/flow-1/deploy`, as('alice', 'POST')));

        for (let request = 0; request < discord; request += 1) {
            expect((await deploy()).status).toBe(403);
        }
        const refused = await deploy();

        expect(refused.status).toBe(429);
        expect(Number(refused.headers.get('Retry-After'))).toBeGreaterThan(0);
        expect(await refused.json()).toEqual({ error: RATE_LIMITED_SENTENCE });
        // Bob has his own budget.
        expect((await app.request(`${GUILD_PATH}/flows/flow-1/deploy`, as('bob', 'POST'))).status).toBe(403);
    });

    it('still signs a user out after their general budget has run out', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const app = buildApp();
        for (let request = 0; request <= general; request += 1) {
            await app.request('/api/guilds', as('alice'));
        }
        expect((await app.request('/api/guilds', as('alice'))).status).toBe(429);

        const loggedOut = await app.request('/api/auth/logout', as('alice', 'POST'));

        expect(loggedOut.ok).toBe(true);
    });

    it('never holds the draft autosave to the Discord budget', async () => {
        const statuses = await statusesOf(discord + 5, `${GUILD_PATH}/flows/flow-1/drafts/mine`, as('alice', 'PUT'));

        expect(statuses.every((status) => status === 403)).toBe(true);
    });
});
