import { Hono } from 'hono';
import { createMiddleware } from 'hono/factory';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppEnv } from '../types';
import { callsDiscord, createUserRateLimiter, RATE_LIMITED_SENTENCE, type UserRateLimiter } from '../rateLimit';

const WINDOW_MS = 60_000;
const GUILD = '/api/guilds/900000000000000001';

/** A limiter with small budgets and a clock the test moves by hand. */
function limiterAt(start: number): { limiter: UserRateLimiter; clock: { now: number } } {
    const clock = { now: start };
    const limiter = createUserRateLimiter({
        windowMs: WINDOW_MS,
        limits: { general: 5, discord: 2 },
        now: () => clock.now,
    });
    return { limiter, clock };
}

/**
 * The limiter behind a stand-in for `requireAuth` that signs in whoever `X-Test-User` names,
 * and a route that answers 200 for any method and path.
 */
function appWith(limiter: UserRateLimiter): Hono<AppEnv> {
    const app = new Hono<AppEnv>();
    app.use(
        '*',
        createMiddleware<AppEnv>(async (c, next) => {
            const id = c.req.header('X-Test-User') ?? 'nobody';
            c.set('user', { id, username: id, avatar: null, manageableGuildIds: [] });
            await next();
        })
    );
    app.use('*', limiter.middleware);
    app.all('*', (c) => c.json({ ok: true }, 200));
    return app;
}

function send(app: Hono<AppEnv>, user: string, path = '/api/nodes', method = 'GET'): Promise<Response> {
    return Promise.resolve(app.request(path, { method, headers: { 'X-Test-User': user } }));
}

afterEach(() => {
    vi.restoreAllMocks();
});

describe('createUserRateLimiter', () => {
    it('lets a user through while the budget has room', async () => {
        const { limiter } = limiterAt(0);
        const app = appWith(limiter);

        for (let request = 0; request < 5; request += 1) {
            expect((await send(app, 'alice')).status).toBe(200);
        }
    });

    it('refuses the request past the budget with a 429, Retry-After and the envelope', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const { limiter, clock } = limiterAt(0);
        const app = appWith(limiter);
        for (let request = 0; request < 5; request += 1) await send(app, 'alice');

        clock.now = 15_500;
        const refused = await send(app, 'alice');

        expect(refused.status).toBe(429);
        // 44.5 s left in the window, rounded up.
        expect(refused.headers.get('Retry-After')).toBe('45');
        expect(await refused.json()).toEqual({ error: RATE_LIMITED_SENTENCE });
    });

    it('logs a user running out once a window, not once a request', async () => {
        const warned = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const { limiter } = limiterAt(0);
        const app = appWith(limiter);

        for (let request = 0; request < 9; request += 1) await send(app, 'alice');

        expect(warned).toHaveBeenCalledTimes(1);
        expect(warned).toHaveBeenCalledWith(expect.stringContaining('alice ran out of the general request budget'));
    });

    it('keeps each user to a budget of their own', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const { limiter } = limiterAt(0);
        const app = appWith(limiter);
        for (let request = 0; request < 6; request += 1) await send(app, 'alice');

        expect((await send(app, 'alice')).status).toBe(429);
        expect((await send(app, 'bob')).status).toBe(200);
    });

    it('starts a fresh budget when the window has passed', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const { limiter, clock } = limiterAt(0);
        const app = appWith(limiter);
        for (let request = 0; request < 5; request += 1) await send(app, 'alice');
        expect((await send(app, 'alice')).status).toBe(429);

        clock.now = WINDOW_MS;

        expect((await send(app, 'alice')).status).toBe(200);
    });

    it('counts a request that calls Discord against the smaller budget as well', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const { limiter } = limiterAt(0);
        const app = appWith(limiter);
        const deploy = `${GUILD}/flows/flow-1/deploy`;

        expect((await send(app, 'alice', deploy, 'POST')).status).toBe(200);
        expect((await send(app, 'alice', deploy, 'POST')).status).toBe(200);
        expect((await send(app, 'alice', deploy, 'POST')).status).toBe(429);
        // The general budget still has room: two counted, the refusal not at all.
        expect((await send(app, 'alice', `${GUILD}/flows`)).status).toBe(200);
    });

    it('names the later reopening when both budgets have run out', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const { limiter, clock } = limiterAt(0);
        const app = appWith(limiter);
        const deploy = `${GUILD}/flows/flow-1/deploy`;
        // The general window opens at 0 s, the Discord one at 30 s.
        await send(app, 'alice');
        clock.now = 30_000;
        await send(app, 'alice', deploy, 'POST');
        await send(app, 'alice', deploy, 'POST');
        await send(app, 'alice');
        await send(app, 'alice');

        clock.now = 40_000;
        const refused = await send(app, 'alice', deploy, 'POST');

        // General reopens in 20 s, Discord in 50 s; a deploy sent after 20 s would be refused.
        expect(refused.status).toBe(429);
        expect(refused.headers.get('Retry-After')).toBe('50');
    });

    it('lets the draft autosave run past the Discord budget', async () => {
        const { limiter } = limiterAt(0);
        const app = appWith(limiter);

        for (let request = 0; request < 5; request += 1) {
            expect((await send(app, 'alice', `${GUILD}/flows/flow-1/drafts/mine`, 'PUT')).status).toBe(200);
        }
    });

    it('drops the counters of users who have gone quiet', async () => {
        const { limiter, clock } = limiterAt(0);
        const app = appWith(limiter);
        await send(app, 'alice');
        await send(app, 'bob', `${GUILD}/leveling`);
        expect(limiter.trackedCount()).toBe(3);

        clock.now = WINDOW_MS;
        await send(app, 'carol');

        // Alice's and Bob's windows had ended; only Carol's new one is left.
        expect(limiter.trackedCount()).toBe(1);
    });

    it('forgets every count on reset', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const { limiter } = limiterAt(0);
        const app = appWith(limiter);
        for (let request = 0; request < 6; request += 1) await send(app, 'alice');

        limiter.reset();

        expect(limiter.trackedCount()).toBe(0);
        expect((await send(app, 'alice')).status).toBe(200);
    });

    it('refuses to run before requireAuth has put a user on the context', async () => {
        const { limiter } = limiterAt(0);
        const app = new Hono<AppEnv>();
        app.use('*', limiter.middleware);
        app.get('*', (c) => c.json({ ok: true }, 200));
        let thrown: unknown;
        app.onError((error, c) => {
            thrown = error;
            return c.json({ error: 'failed' }, 500);
        });

        expect((await app.request('/api/nodes')).status).toBe(500);
        expect(thrown).toEqual(expect.objectContaining({ message: expect.stringContaining('before requireAuth') }));
    });
});

describe('callsDiscord', () => {
    it.each([
        ['POST', `${GUILD}/flows/flow-1/deploy`],
        ['POST', `${GUILD}/flows/flow-1/install`],
        ['POST', `${GUILD}/journeys/onboarding/repair`],
        ['POST', `${GUILD}/tickets/12/close`],
        ['PUT', `${GUILD}/settings`],
        ['PUT', `${GUILD}/flows/flow-1`],
        ['DELETE', `${GUILD}/flows/flow-1/drafts/7`],
        ['GET', `${GUILD}/leveling`],
        ['GET', `${GUILD}/leveling/users/900000000000000002`],
        ['GET', `${GUILD}/journeys/onboarding/drift`],
    ])('counts %s %s against the Discord budget', (method, path) => {
        expect(callsDiscord(method, path)).toBe(true);
    });

    it.each([
        ['PUT', `${GUILD}/flows/flow-1/drafts/mine`],
        ['PUT', `${GUILD}/flows/flow-1/resources`],
        ['PUT', `${GUILD}/journeys/onboarding`],
        ['POST', `${GUILD}/flows/flow-1/check`],
        ['GET', `${GUILD}/channels`],
        ['GET', `${GUILD}/roles`],
        ['GET', `${GUILD}/leveling/insights`],
        ['GET', `${GUILD}/tickets`],
        ['GET', `${GUILD}/journeys/onboarding/published`],
        ['GET', `${GUILD}/flows/flow-1/install-plan`],
        ['GET', '/api/guilds'],
        ['GET', '/api/nodes'],
        ['POST', '/api/auth/logout'],
    ])('leaves %s %s to the general budget alone', (method, path) => {
        expect(callsDiscord(method, path)).toBe(false);
    });
});
