import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppEnv } from '../../types';

/**
 * The journey API contract.
 *
 * `journeyRoutes()` is a bare Hono app — auth and guild resolution are applied where
 * it is mounted in `api/index.ts` — so these tests inject a guild directly and focus
 * on what the routes themselves decide: validation, status codes, and guild scoping.
 *
 * The repo is mocked here on purpose. Whether the *storage* behaves is settled
 * against real SQL in `journeys.integration.test.ts`; duplicating that through HTTP
 * would test SQLite twice and the routing layer once.
 */

const repo = {
    listByGuildId: vi.fn(),
    getByKey: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    deleteByKey: vi.fn(),
};

class DuplicateJourneyKeyError extends Error {
    constructor() {
        super('duplicate');
        this.name = 'DuplicateJourneyKeyError';
    }
}

vi.mock('../../../features/provisioning/data/journeysRepo', () => ({
    journeysRepo: repo,
    DuplicateJourneyKeyError,
}));

const { journeyRoutes } = await import('../journeyRoutes');

const GUILD_ID = 'guild-1';

const RESOURCES = [
    { key: 'qa-category', kind: 'category', defaultName: 'Questions' },
    { key: 'qa-channel', kind: 'textChannel', defaultName: 'questions', parentKey: 'qa-category' },
];

function journeyRow(overrides: Record<string, unknown> = {}) {
    return {
        journeyKey: 'qa',
        guildId: GUILD_ID,
        name: 'Q&A',
        description: null,
        resources: RESOURCES,
        createdAt: new Date('2026-09-19T10:00:00Z'),
        updatedAt: new Date('2026-09-19T10:00:00Z'),
        ...overrides,
    };
}

/**
 * Mount the routes behind a stub that supplies the guild the real middleware would
 * have resolved, so the handlers run exactly as they do in production.
 */
function app() {
    const outer = new Hono<AppEnv>();
    outer.use('*', async (c, next) => {
        c.set('guild', { id: GUILD_ID } as never);
        await next();
    });
    outer.route('/', journeyRoutes());
    return outer;
}

async function post(body: unknown) {
    return app().request(`/${GUILD_ID}/journeys`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
    });
}

beforeEach(() => {
    vi.clearAllMocks();
});

describe('journey routes', () => {
    it('creates a journey and returns 201 with its detail', async () => {
        repo.getByKey.mockResolvedValue(null);
        repo.create.mockResolvedValue(journeyRow());

        const response = await post({ journeyKey: 'qa', name: 'Q&A', resources: RESOURCES });

        expect(response.status).toBe(201);
        const body = (await response.json()) as { journeyKey: string; resources: unknown };
        expect(body.journeyKey).toBe('qa');
        expect(body.resources).toEqual(RESOURCES);
        // The guild comes from the resolved context, never from the body — a client
        // cannot write into another server by asking.
        expect(repo.create).toHaveBeenCalledWith(expect.objectContaining({ guildId: GUILD_ID }));
    });

    it('ignores a guildId supplied in the request body', async () => {
        repo.getByKey.mockResolvedValue(null);
        repo.create.mockResolvedValue(journeyRow());

        await post({
            journeyKey: 'qa',
            name: 'Q&A',
            resources: RESOURCES,
            guildId: 'someone-elses-guild',
        });

        expect(repo.create).toHaveBeenCalledWith(expect.objectContaining({ guildId: GUILD_ID }));
    });

    it('rejects a resource key that is not slug-shaped', async () => {
        const response = await post({
            journeyKey: 'qa',
            name: 'Q&A',
            resources: [{ key: 'Not A Key!', kind: 'category', defaultName: 'Questions' }],
        });

        expect(response.status).toBe(400);
        expect(repo.create).not.toHaveBeenCalled();
    });

    it('rejects an unknown resource kind', async () => {
        const response = await post({
            journeyKey: 'qa',
            name: 'Q&A',
            resources: [{ key: 'voice-room', kind: 'voiceChannel', defaultName: 'Voice' }],
        });

        // `voiceChannel` is a plausible thing to ask for and has no creation code
        // behind it. Accepting it would fail at apply time, mid-mutation.
        expect(response.status).toBe(400);
        expect(repo.create).not.toHaveBeenCalled();
    });

    it('rejects a `roles` permission that names no roles', async () => {
        const response = await post({
            journeyKey: 'qa',
            name: 'Q&A',
            resources: [
                {
                    key: 'qa-channel',
                    kind: 'textChannel',
                    defaultName: 'questions',
                    permissions: [{ audience: 'roles', access: 'readWrite' }],
                },
            ],
        });

        expect(response.status).toBe(400);
        const body = (await response.json()) as { error: string };
        expect(body.error).toMatch(/at least one role/i);
    });

    it('accepts a `staff` permission without role ids', async () => {
        repo.getByKey.mockResolvedValue(null);
        repo.create.mockResolvedValue(journeyRow());

        // Staff roles are a guild fact supplied at install time, not by the
        // declaration — that separation is what keeps a journey portable.
        const response = await post({
            journeyKey: 'qa',
            name: 'Q&A',
            resources: [
                {
                    key: 'qa-notes',
                    kind: 'textChannel',
                    defaultName: 'notes',
                    permissions: [
                        { audience: 'everyone', access: 'hidden' },
                        { audience: 'staff', access: 'readWrite' },
                    ],
                },
            ],
        });

        expect(response.status).toBe(201);
    });

    it('returns 409 when the key is already taken in this guild', async () => {
        repo.getByKey.mockResolvedValue(null);
        repo.create.mockRejectedValue(new DuplicateJourneyKeyError());

        const response = await post({ journeyKey: 'qa', name: 'Q&A', resources: RESOURCES });

        expect(response.status).toBe(409);
    });

    it('returns 404 for a journey in another guild', async () => {
        repo.getByKey.mockResolvedValue(null);

        const response = await app().request(`/${GUILD_ID}/journeys/not-mine`);

        expect(response.status).toBe(404);
        // Scoped by the resolved guild, so another server's journey is indistinguishable
        // from one that does not exist.
        expect(repo.getByKey).toHaveBeenCalledWith(GUILD_ID, 'not-mine');
    });

    it('does not call the repo update when the journey is missing', async () => {
        repo.getByKey.mockResolvedValue(null);

        const response = await app().request(`/${GUILD_ID}/journeys/qa`, {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name: 'Renamed' }),
        });

        expect(response.status).toBe(404);
        expect(repo.update).not.toHaveBeenCalled();
    });

    it('deletes an existing journey and returns 204', async () => {
        repo.getByKey.mockResolvedValue(journeyRow());

        const response = await app().request(`/${GUILD_ID}/journeys/qa`, { method: 'DELETE' });

        expect(response.status).toBe(204);
        expect(repo.deleteByKey).toHaveBeenCalledWith(GUILD_ID, 'qa');
    });

    it('lists journeys as summaries without resource bodies', async () => {
        repo.listByGuildId.mockResolvedValue([journeyRow()]);

        const response = await app().request(`/${GUILD_ID}/journeys`);
        const body = (await response.json()) as {
            journeys: readonly { resourceCount: number; resources?: unknown }[];
        };

        expect(body.journeys[0].resourceCount).toBe(2);
        expect(body.journeys[0].resources).toBeUndefined();
    });
});
