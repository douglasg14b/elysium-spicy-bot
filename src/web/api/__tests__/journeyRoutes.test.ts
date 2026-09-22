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

const flowsRepoMock = {
    getByFlowId: vi.fn(),
};

vi.mock('../../../features/flows/data/flowsRepo', () => ({
    flowsRepo: flowsRepoMock,
}));

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

/**
 * The link table, mocked for the same reason the journeys repo is: whether the rows
 * store is settled against real SQL in `flowJourneyLinks.integration.test.ts`.
 *
 * `resolveFlowJourney` is deliberately **not** mocked. It is the thing deciding which
 * journey each of these routes acts on, and stubbing it would leave the routes tested
 * against a resolution rule no code implements — so it runs for real over these two
 * mocked repos.
 */
const linksRepo = {
    getJourneyKeyForFlow: vi.fn(),
    listFlowIdsForJourney: vi.fn(),
    attach: vi.fn(),
    detachFlow: vi.fn(),
};

vi.mock('../../../features/provisioning/data/flowJourneyLinksRepo', () => ({
    flowJourneyLinksRepo: linksRepo,
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
    // Unattached is the baseline, so every existing case still describes a flow whose
    // journey is resolved by the implicit key rule. Cases about attachment say so.
    linksRepo.getJourneyKeyForFlow.mockResolvedValue(null);
    linksRepo.listFlowIdsForJourney.mockResolvedValue([]);
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

    it('rejects an adoption id that is not a snowflake', async () => {
        // A non-id reaching the plan surfaces as "this channel does not exist", which
        // sends the operator looking for a deletion that never happened.
        const response = await post({
            journeyKey: 'qa',
            name: 'Q&A',
            resources: [
                {
                    key: 'qa-channel',
                    kind: 'textChannel',
                    defaultName: 'questions',
                    adoptDiscordId: 'not-a-snowflake',
                },
            ],
        });

        expect(response.status).toBe(400);
        const body = (await response.json()) as { error: string };
        expect(body.error).toMatch(/17 to 20 digits/i);
        expect(repo.create).not.toHaveBeenCalled();
    });

    it('accepts a resource adopting a real snowflake', async () => {
        repo.getByKey.mockResolvedValue(null);
        repo.create.mockResolvedValue(journeyRow());

        const response = await post({
            journeyKey: 'qa',
            name: 'Q&A',
            resources: [
                {
                    key: 'qa-channel',
                    kind: 'textChannel',
                    defaultName: 'questions',
                    adoptDiscordId: '100000000000000001',
                },
            ],
        });

        expect(response.status).toBe(201);
        // The field must survive to the repo — a schema that parses it and drops it
        // is worse than one that rejects it, because the panel would look like it
        // worked and install would create a duplicate channel.
        expect(repo.create).toHaveBeenCalledWith(
            expect.objectContaining({
                resources: [expect.objectContaining({ adoptDiscordId: '100000000000000001' })],
            })
        );
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

    /**
     * Deleting a journey out from under the flows that install it.
     *
     * The refusal is the guard, and the naming is the product of it: an operator told
     * only that "2 flows" are attached has to go and find them, which is the shape
     * `dialog-copy-density-over-prose` rejects.
     */
    describe('with flows still attached', () => {
        it('refuses the delete and names every attached flow', async () => {
            repo.getByKey.mockResolvedValue(journeyRow({ name: 'Onboarding' }));
            linksRepo.listFlowIdsForJourney.mockResolvedValue(['flow-a', 'flow-b']);
            flowsRepoMock.getByFlowId.mockImplementation(async (flowId: string) =>
                flowId === 'flow-a'
                    ? { flowId, guildId: GUILD_ID, name: 'Welcome wagon' }
                    : { flowId, guildId: GUILD_ID, name: 'Age check' }
            );

            const response = await app().request(`/${GUILD_ID}/journeys/qa`, { method: 'DELETE' });
            const body = (await response.json()) as { error: string };

            expect(response.status).toBe(409);
            // Nothing was deleted — the refusal is the whole point, and a 409 with the
            // row already gone would be worse than no check at all.
            expect(repo.deleteByKey).not.toHaveBeenCalled();
            // By name, each one, not a count.
            expect(body.error).toContain('Welcome wagon');
            expect(body.error).toContain('Age check');
            expect(body.error).toContain('Onboarding');
        });

        it('names the one flow in the singular', async () => {
            repo.getByKey.mockResolvedValue(journeyRow({ name: 'Onboarding' }));
            linksRepo.listFlowIdsForJourney.mockResolvedValue(['flow-a']);
            flowsRepoMock.getByFlowId.mockResolvedValue({
                flowId: 'flow-a',
                guildId: GUILD_ID,
                name: 'Welcome wagon',
            });

            const response = await app().request(`/${GUILD_ID}/journeys/qa`, { method: 'DELETE' });
            const body = (await response.json()) as { error: string };

            expect(response.status).toBe(409);
            expect(body.error).toContain('the flow **Welcome wagon**');
            expect(repo.deleteByKey).not.toHaveBeenCalled();
        });

        it('falls back to the flow id when the flow row has vanished', async () => {
            repo.getByKey.mockResolvedValue(journeyRow());
            linksRepo.listFlowIdsForJourney.mockResolvedValue(['flow-a']);
            flowsRepoMock.getByFlowId.mockResolvedValue(null);

            const response = await app().request(`/${GUILD_ID}/journeys/qa`, { method: 'DELETE' });
            const body = (await response.json()) as { error: string };

            // A dangling link still blocks the delete. Dropping it from the list would
            // refuse for a reason the message does not mention.
            expect(response.status).toBe(409);
            expect(body.error).toContain('flow-a');
        });

        it('never puts another guild\'s flow name in the message', async () => {
            repo.getByKey.mockResolvedValue(journeyRow());
            linksRepo.listFlowIdsForJourney.mockResolvedValue(['flow-a']);
            // `flowsRepo.getByFlowId` matches on the id alone, so the guild check is
            // this route's job — and the name is about to go in a response body.
            flowsRepoMock.getByFlowId.mockResolvedValue({
                flowId: 'flow-a',
                guildId: 'someone-elses-guild',
                name: 'Their private flow',
            });

            const response = await app().request(`/${GUILD_ID}/journeys/qa`, { method: 'DELETE' });
            const body = (await response.json()) as { error: string };

            expect(response.status).toBe(409);
            expect(body.error).not.toContain('Their private flow');
            expect(body.error).toContain('flow-a');
        });
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

/**
 * The flow-scoped surface the builder panel actually uses.
 *
 * A flow's journey is implicit — keyed on the flow's own id — so these routes are
 * what makes "journeys are created implicitly with a flow" true rather than a
 * convention the UI has to remember.
 */
describe('flow resource declarations', () => {
    const FLOW_ID = '11111111-2222-3333-4444-555555555555';

    async function putResources(resources: unknown) {
        return app().request(`/${GUILD_ID}/flows/${FLOW_ID}/resources`, {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ resources }),
        });
    }

    beforeEach(() => {
        flowsRepoMock.getByFlowId.mockResolvedValue({ flowId: FLOW_ID, guildId: GUILD_ID, name: 'Q&A' });
    });

    it('returns an empty list for a flow that has declared nothing', async () => {
        repo.getByKey.mockResolvedValue(null);

        const response = await app().request(`/${GUILD_ID}/flows/${FLOW_ID}/resources`);

        // Not a 404: having declared nothing is the normal state of every flow.
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ resources: [] });
    });

    it('creates the journey on the first save, keyed on the flow id', async () => {
        repo.getByKey.mockResolvedValue(null);
        repo.create.mockResolvedValue(journeyRow({ resources: RESOURCES }));

        const response = await putResources(RESOURCES);

        expect(response.status).toBe(200);
        expect(repo.create).toHaveBeenCalledWith(
            expect.objectContaining({
                guildId: GUILD_ID,
                journeyKey: FLOW_ID,
                createdForFlowId: FLOW_ID,
            })
        );
    });

    it('updates in place on later saves rather than creating a second journey', async () => {
        repo.getByKey.mockResolvedValue(journeyRow({ journeyKey: FLOW_ID }));
        repo.update.mockResolvedValue(journeyRow({ resources: RESOURCES }));

        await putResources(RESOURCES);

        expect(repo.create).not.toHaveBeenCalled();
        expect(repo.update).toHaveBeenCalledWith(GUILD_ID, FLOW_ID, { resources: RESOURCES });
    });

    it('deletes the journey when the last resource is removed', async () => {
        repo.getByKey.mockResolvedValue(journeyRow({ journeyKey: FLOW_ID }));

        const response = await putResources([]);

        // An empty declaration is *no* journey, not an empty one — the repo rejects a
        // journey with no resources, since installing it would do nothing.
        expect(response.status).toBe(200);
        expect(repo.deleteByKey).toHaveBeenCalledWith(GUILD_ID, FLOW_ID);
        expect(repo.update).not.toHaveBeenCalled();
        expect(repo.create).not.toHaveBeenCalled();
    });

    /**
     * What the link table changes about this surface: the journey a flow reads and
     * writes is the one it is attached to, not the one keyed with its id.
     */
    describe('once a flow is attached to a journey', () => {
        beforeEach(() => {
            linksRepo.getJourneyKeyForFlow.mockResolvedValue('named-journey');
            repo.getByKey.mockResolvedValue(
                journeyRow({ journeyKey: 'named-journey', resources: RESOURCES })
            );
            // Alone on it: the key is not the flow id, but no other flow is attached.
            linksRepo.listFlowIdsForJourney.mockResolvedValue([FLOW_ID]);
        });

        it('reads the journey resources rather than finding none of its own', async () => {
            const response = await app().request(`/${GUILD_ID}/flows/${FLOW_ID}/resources`);

            expect(await response.json()).toEqual({ resources: RESOURCES });
            // The bug this whole slice exists for: looking up by the flow's own id.
            expect(repo.getByKey).toHaveBeenCalledWith(GUILD_ID, 'named-journey');
        });

        it('saves into that journey rather than creating a second one', async () => {
            repo.update.mockResolvedValue(journeyRow({ journeyKey: 'named-journey' }));

            await putResources(RESOURCES);

            expect(repo.create).not.toHaveBeenCalled();
            expect(repo.update).toHaveBeenCalledWith(GUILD_ID, 'named-journey', {
                resources: RESOURCES,
            });
        });

        it('lets the only attached flow clear it, despite the foreign key', async () => {
            const response = await putResources([]);

            // A journey nobody else holds is this flow's to clear. Refusing on the
            // strength of `journeyKey !== flowId` would tell a flow alone on a named
            // journey that it "shares" one, which is simply untrue.
            expect(response.status).toBe(200);
            // Deleted by the **resolved** key. Asserting only that it was called lets
            // through a delete that matches no row and reports success anyway, leaving
            // the journey behind attached to nobody.
            expect(repo.deleteByKey).toHaveBeenCalledWith(GUILD_ID, 'named-journey');
            expect(linksRepo.detachFlow).toHaveBeenCalledWith(GUILD_ID, FLOW_ID);
        });
    });

    /**
     * The guard that protects the other flows on a journey.
     *
     * Asked of the **link table**, not of whether the key equals the flow id. That
     * comparison is right only while a journey holds one flow — so it fails in both
     * directions the moment sharing is used, and the false negative is silent data
     * loss for a flow nobody was looking at.
     */
    describe('when other flows share the journey', () => {
        beforeEach(() => {
            repo.getByKey.mockResolvedValue(journeyRow({ journeyKey: FLOW_ID, name: 'Onboarding' }));
            linksRepo.getJourneyKeyForFlow.mockResolvedValue(FLOW_ID);
            // The dangerous shape: the journey is keyed on *this* flow's id — so the
            // old convention check saw nothing wrong — and a second flow is attached.
            linksRepo.listFlowIdsForJourney.mockResolvedValue([FLOW_ID, 'flow-b']);
            flowsRepoMock.getByFlowId.mockImplementation(async (flowId: string) =>
                flowId === FLOW_ID
                    ? { flowId, guildId: GUILD_ID, name: 'Q&A' }
                    : { flowId, guildId: GUILD_ID, name: 'Welcome wagon' }
            );
        });

        it('refuses to clear the journey, naming the flow that would lose it', async () => {
            const response = await putResources([]);
            const body = (await response.json()) as { error: string };

            expect(response.status).toBe(409);
            expect(repo.deleteByKey).not.toHaveBeenCalled();
            expect(linksRepo.detachFlow).not.toHaveBeenCalled();
            expect(body.error).toContain('Welcome wagon');
        });

        it('refuses to replace the resources on it', async () => {
            const response = await putResources(RESOURCES);
            const body = (await response.json()) as { error: string };

            // `update` replaces `resources` wholesale, so dropping four of five is the
            // same damage as clearing them — guarding only the empty case would leave
            // the destructive path a resource shorter than the one it guards.
            expect(response.status).toBe(409);
            expect(repo.update).not.toHaveBeenCalled();
            expect(body.error).toContain('Welcome wagon');
        });
    });

    it('records the link when it creates a flow\'s implicit journey', async () => {
        repo.getByKey.mockResolvedValue(null);
        repo.create.mockResolvedValue(journeyRow({ journeyKey: FLOW_ID, resources: RESOURCES }));

        await putResources(RESOURCES);

        // Implicit from birth, but explicit in the data — so nothing downstream has to
        // fall back on the key convention for a journey created after this shipped.
        expect(linksRepo.attach).toHaveBeenCalledWith({
            guildId: GUILD_ID,
            flowId: FLOW_ID,
            journeyKey: FLOW_ID,
        });
    });

    it('drops the link when the flow stops declaring anything', async () => {
        repo.getByKey.mockResolvedValue(journeyRow({ journeyKey: FLOW_ID }));

        await putResources([]);

        expect(linksRepo.detachFlow).toHaveBeenCalledWith(GUILD_ID, FLOW_ID);
    });

    it('refuses to declare resources against another guild\'s flow', async () => {
        flowsRepoMock.getByFlowId.mockResolvedValue({
            flowId: FLOW_ID,
            guildId: 'someone-elses-guild',
            name: 'Not mine',
        });

        const response = await putResources(RESOURCES);

        expect(response.status).toBe(404);
        expect(repo.create).not.toHaveBeenCalled();
        expect(repo.update).not.toHaveBeenCalled();
    });

    it('validates declarations on the flow-scoped route too', async () => {
        repo.getByKey.mockResolvedValue(null);

        const response = await putResources([
            { key: 'Not A Key!', kind: 'category', defaultName: 'Nope' },
        ]);

        expect(response.status).toBe(400);
        expect(repo.create).not.toHaveBeenCalled();
    });
});
