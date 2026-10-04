import { describe, expect, it } from 'vitest';
import { buildApp } from '../server';

/**
 * What the whole web app answers for an `/api` path no route serves.
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
});
