import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppEnv } from '../../types';

/**
 * Attach and detach — slice D's product, and the routes that make a link row something
 * an operator writes rather than a by-product of a flow saving its own resources.
 *
 * **`POST /attach` is the trust boundary for `flowJourney()`'s ownership check.** That
 * guard treats a link row as positive evidence that a flow may install a journey, and
 * install *creates channels and roles*. Before this route, the only writer of a link row
 * was the flow's own resource save, which made the evidence self-evidently the flow's.
 * These cases pin the two properties that keep it just as strong now that an operator
 * supplies the key: the journey must already exist **in this guild**, and the flow must
 * be **in this guild** too.
 *
 * The repos are mocked for the same reason the sibling suites mock them — whether the
 * rows store is settled against real SQL in `flowJourneyLinks.integration.test.ts`.
 * `resolveFlowJourney` is deliberately real: which journey a flow is on is exactly what
 * these routes report and move.
 */

const journeysRepoMock = {
    listByGuildId: vi.fn(),
    getByKey: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    deleteByKey: vi.fn(),
};

const flowsRepoMock = {
    getByFlowId: vi.fn(),
    getByGuildId: vi.fn(),
};

class DuplicateJourneyKeyError extends Error {}

vi.mock('../../../features/flows/data/flowsRepo', () => ({ flowsRepo: flowsRepoMock }));
vi.mock('../../../features/provisioning/data/journeysRepo', () => ({
    journeysRepo: journeysRepoMock,
    DuplicateJourneyKeyError,
}));

const linksRepo = {
    getJourneyKeyForFlow: vi.fn(),
    listFlowIdsForJourney: vi.fn(),
    listLinksForGuild: vi.fn(),
    attach: vi.fn(),
    detachFlow: vi.fn(),
};

vi.mock('../../../features/provisioning/data/flowJourneyLinksRepo', () => ({
    flowJourneyLinksRepo: linksRepo,
}));

const { journeyRoutes } = await import('../journeyRoutes');

const GUILD_ID = 'guild-1';
const OTHER_GUILD = 'someone-elses-guild';
const FLOW_ID = '11111111-2222-3333-4444-555555555555';

function journeyRow(overrides: Record<string, unknown> = {}) {
    return {
        journeyKey: 'onboarding',
        guildId: GUILD_ID,
        name: 'Onboarding',
        description: null,
        createdForFlowId: null,
        resources: [{ key: 'qa-channel', kind: 'textChannel', defaultName: 'questions' }],
        createdAt: new Date('2026-09-19T10:00:00Z'),
        updatedAt: new Date('2026-09-19T10:00:00Z'),
        ...overrides,
    };
}

function app() {
    const outer = new Hono<AppEnv>();
    outer.use('*', async (c, next) => {
        c.set('guild', { id: GUILD_ID } as never);
        await next();
    });
    outer.route('/', journeyRoutes());
    return outer;
}

function attach(journeyKey: unknown, flowId: string = FLOW_ID) {
    return app().request(`/${GUILD_ID}/flows/${flowId}/attach`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ journeyKey }),
    });
}

function detach(flowId: string = FLOW_ID) {
    return app().request(`/${GUILD_ID}/flows/${flowId}/detach`, { method: 'POST' });
}

beforeEach(() => {
    vi.clearAllMocks();
    flowsRepoMock.getByFlowId.mockResolvedValue({
        flowId: FLOW_ID,
        guildId: GUILD_ID,
        name: 'Welcome wagon',
    });
    journeysRepoMock.getByKey.mockResolvedValue(journeyRow());
    linksRepo.getJourneyKeyForFlow.mockResolvedValue(null);
    linksRepo.listFlowIdsForJourney.mockResolvedValue([]);
});

describe('attaching a flow to a journey', () => {
    it('writes the link and reports the journey it joined', async () => {
        const response = await attach('onboarding');

        expect(response.status).toBe(200);
        expect(linksRepo.attach).toHaveBeenCalledWith({
            guildId: GUILD_ID,
            flowId: FLOW_ID,
            journeyKey: 'onboarding',
        });
        const body = (await response.json()) as { name: string; movedFrom: unknown };
        expect(body.name).toBe('Onboarding');
        // Nothing to leave: this flow was on no journey.
        expect(body.movedFrom).toBeNull();
    });

    /**
     * **A flow has at most one journey**, enforced by the unique index on
     * `(guildId, flowId)`, so `attach` is an upsert and attaching an already-attached
     * flow *moves* it.
     *
     * Asserted as a single `attach` call carrying the new key rather than a detach
     * followed by an insert: a two-statement move has a window where the flow is on
     * neither journey, and a failure inside it strands the flow unable to install while
     * its channels stand in the guild.
     */
    it('moves an already-attached flow rather than adding a second journey', async () => {
        linksRepo.getJourneyKeyForFlow.mockResolvedValue('old-journey');
        journeysRepoMock.getByKey.mockImplementation(async (_guildId: string, key: string) =>
            key === 'old-journey'
                ? journeyRow({ journeyKey: 'old-journey', name: 'Old thing' })
                : journeyRow()
        );

        const response = await attach('onboarding');
        const body = (await response.json()) as {
            movedFrom: { journeyKey: string; name: string } | null;
        };

        expect(response.status).toBe(200);
        // One statement. The upsert is the move.
        expect(linksRepo.attach).toHaveBeenCalledTimes(1);
        expect(linksRepo.attach).toHaveBeenCalledWith({
            guildId: GUILD_ID,
            flowId: FLOW_ID,
            journeyKey: 'onboarding',
        });
        expect(linksRepo.detachFlow).not.toHaveBeenCalled();
        // Named, so the UI can say what was left rather than implying two journeys.
        expect(body.movedFrom).toEqual({ journeyKey: 'old-journey', name: 'Old thing' });
    });

    it('reports no move when the flow is re-attached where it already is', async () => {
        linksRepo.getJourneyKeyForFlow.mockResolvedValue('onboarding');

        const body = (await (await attach('onboarding')).json()) as { movedFrom: unknown };

        expect(body.movedFrom).toBeNull();
    });

    /**
     * The ownership guard's own hazard, refused at the boundary that would otherwise
     * manufacture the evidence.
     *
     * `flowJourney()` treats a link row as proof that this flow may install a journey.
     * If attach created a journey for a key that names nothing — or linked one anyway —
     * a typed key would become an installable journey with no declaration behind it,
     * which is exactly the failure the guard exists to prevent. A 404 instead.
     */
    it('refuses a journey key that names nothing, rather than creating one', async () => {
        journeysRepoMock.getByKey.mockResolvedValue(null);

        const response = await attach('typo-nobody-declared');

        expect(response.status).toBe(404);
        expect(linksRepo.attach).not.toHaveBeenCalled();
        expect(journeysRepoMock.create).not.toHaveBeenCalled();
    });

    it("refuses to attach another guild's flow without confirming it exists", async () => {
        flowsRepoMock.getByFlowId.mockResolvedValue({
            flowId: FLOW_ID,
            guildId: OTHER_GUILD,
            name: 'Their private flow',
        });

        const response = await attach('onboarding');
        const body = (await response.json()) as { error: string };

        // 404 rather than 403: never confirm another guild's flow exists.
        expect(response.status).toBe(404);
        expect(body.error).toBe('Flow not found.');
        expect(body.error).not.toContain('Their private flow');
        expect(linksRepo.attach).not.toHaveBeenCalled();
    });

    /**
     * The journey lookup is guild-scoped, so a key that exists in *another* server is
     * indistinguishable from one that exists nowhere.
     *
     * Without this an operator could link their flow to a journey belonging to a guild
     * they cannot see, and install would then create that guild's channel layout in
     * theirs.
     */
    it('scopes the journey lookup to this guild', async () => {
        journeysRepoMock.getByKey.mockResolvedValue(null);

        await attach('onboarding');

        expect(journeysRepoMock.getByKey).toHaveBeenCalledWith(GUILD_ID, 'onboarding');
        expect(linksRepo.attach).not.toHaveBeenCalled();
    });

    it('rejects a journey key that is not slug-shaped before touching any repo', async () => {
        const response = await attach('Not A Key!');

        expect(response.status).toBe(400);
        expect(linksRepo.attach).not.toHaveBeenCalled();
    });

    it('ignores a guildId supplied in the body and links into the resolved guild', async () => {
        await app().request(`/${GUILD_ID}/flows/${FLOW_ID}/attach`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ journeyKey: 'onboarding', guildId: OTHER_GUILD }),
        });

        expect(linksRepo.attach).toHaveBeenCalledWith(
            expect.objectContaining({ guildId: GUILD_ID })
        );
    });
});

describe('detaching a flow', () => {
    /**
     * **Detach is not a teardown.**
     *
     * `resource_bindings` name channels and roles that exist in the guild. Dropping them
     * because a flow walked away would orphan real Discord objects with nothing left
     * that knows we created them — so removing them is `/unpublish`'s job and an
     * operator has to ask for it.
     */
    it('removes the link and leaves the journey and its bindings alone', async () => {
        linksRepo.getJourneyKeyForFlow.mockResolvedValue('onboarding');
        linksRepo.detachFlow.mockResolvedValue(true);

        const response = await detach();

        expect(response.status).toBe(200);
        expect(linksRepo.detachFlow).toHaveBeenCalledWith(GUILD_ID, FLOW_ID);
        // The journey row survives — other flows may still hold it, and this route has
        // no business deciding a journey is finished because one flow left.
        expect(journeysRepoMock.deleteByKey).not.toHaveBeenCalled();
        expect(journeysRepoMock.update).not.toHaveBeenCalled();
    });

    it("refuses to detach another guild's flow without confirming it exists", async () => {
        flowsRepoMock.getByFlowId.mockResolvedValue({
            flowId: FLOW_ID,
            guildId: OTHER_GUILD,
            name: 'Their private flow',
        });

        const response = await detach();

        expect(response.status).toBe(404);
        expect(linksRepo.detachFlow).not.toHaveBeenCalled();
    });

    it('succeeds for a flow that was already attached to nothing', async () => {
        linksRepo.detachFlow.mockResolvedValue(false);

        const response = await detach();

        // The caller asked for "not attached" and that is the state. A 404 would report
        // a failure for reaching the outcome they wanted.
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ detached: false });
    });
});

describe('reading a flow\'s attachment', () => {
    function get(flowId: string = FLOW_ID) {
        return app().request(`/${GUILD_ID}/flows/${flowId}/attachment`);
    }

    it('names the journey and the other flows sharing it', async () => {
        linksRepo.getJourneyKeyForFlow.mockResolvedValue('onboarding');
        linksRepo.listFlowIdsForJourney.mockResolvedValue([FLOW_ID, 'flow-b']);
        flowsRepoMock.getByFlowId.mockImplementation(async (flowId: string) =>
            flowId === FLOW_ID
                ? { flowId, guildId: GUILD_ID, name: 'Welcome wagon' }
                : { flowId, guildId: GUILD_ID, name: 'Age check' }
        );

        const body = (await (await get()).json()) as {
            attachment: { name: string; sharedWith: { name: string }[] };
        };

        expect(body.attachment.name).toBe('Onboarding');
        // The asking flow is not "shared with" itself.
        expect(body.attachment.sharedWith).toEqual([{ flowId: 'flow-b', name: 'Age check' }]);
    });

    it('reports null for a flow attached to nothing', async () => {
        journeysRepoMock.getByKey.mockResolvedValue(null);

        const body = (await (await get()).json()) as { attachment: unknown };

        expect(body.attachment).toBeNull();
    });

    it("never puts another guild's flow name in the shared list", async () => {
        linksRepo.getJourneyKeyForFlow.mockResolvedValue('onboarding');
        linksRepo.listFlowIdsForJourney.mockResolvedValue([FLOW_ID, 'flow-b']);
        flowsRepoMock.getByFlowId.mockImplementation(async (flowId: string) =>
            flowId === FLOW_ID
                ? { flowId, guildId: GUILD_ID, name: 'Welcome wagon' }
                : { flowId, guildId: OTHER_GUILD, name: 'Their private flow' }
        );

        const body = (await (await get()).json()) as {
            attachment: { sharedWith: { name: string }[] };
        };

        // The id survives as the label — a dangling or foreign link still holds the
        // journey — but the name does not cross the guild.
        expect(body.attachment.sharedWith).toEqual([{ flowId: 'flow-b', name: 'flow-b' }]);
    });
});

/**
 * The journeys list, which slice C's page renders.
 *
 * The attachments are the point of it: an operator needs to see which flows hold a
 * journey *before* pressing a delete the server is going to refuse.
 */
describe('the journeys list', () => {
    it('names the flows attached to each journey', async () => {
        journeysRepoMock.listByGuildId.mockResolvedValue([
            journeyRow(),
            journeyRow({ journeyKey: 'rules', name: 'Rules' }),
        ]);
        linksRepo.listLinksForGuild.mockResolvedValue([
            { flowId: FLOW_ID, journeyKey: 'onboarding' },
            { flowId: 'flow-b', journeyKey: 'onboarding' },
        ]);
        flowsRepoMock.getByGuildId.mockResolvedValue([
            { flowId: FLOW_ID, guildId: GUILD_ID, name: 'Welcome wagon' },
            { flowId: 'flow-b', guildId: GUILD_ID, name: 'Age check' },
        ]);

        const body = (await (await app().request(`/${GUILD_ID}/journeys`)).json()) as {
            journeys: { journeyKey: string; attachedFlows: { name: string }[] }[];
        };

        expect(body.journeys[0].attachedFlows.map((flow) => flow.name)).toEqual([
            'Welcome wagon',
            'Age check',
        ]);
        expect(body.journeys[1].attachedFlows).toEqual([]);
    });

    /**
     * One query for the links, one for the names — not one of each per journey.
     *
     * The N+1 is the shape that looks fine on the three journeys a developer has and
     * degrades on the forty an operator accumulates, and it is invisible to a test that
     * only checks the body.
     */
    it('reads the links and the flow names once each, not per journey', async () => {
        journeysRepoMock.listByGuildId.mockResolvedValue([
            journeyRow(),
            journeyRow({ journeyKey: 'rules', name: 'Rules' }),
            journeyRow({ journeyKey: 'tickets', name: 'Tickets' }),
        ]);
        linksRepo.listLinksForGuild.mockResolvedValue([]);
        flowsRepoMock.getByGuildId.mockResolvedValue([]);

        await app().request(`/${GUILD_ID}/journeys`);

        expect(linksRepo.listLinksForGuild).toHaveBeenCalledTimes(1);
        expect(flowsRepoMock.getByGuildId).toHaveBeenCalledTimes(1);
        // The per-journey calls the naive shape would have made.
        expect(linksRepo.listFlowIdsForJourney).not.toHaveBeenCalled();
        expect(flowsRepoMock.getByFlowId).not.toHaveBeenCalled();
    });

    it('falls back to the flow id when a link names a flow that is gone', async () => {
        journeysRepoMock.listByGuildId.mockResolvedValue([journeyRow()]);
        linksRepo.listLinksForGuild.mockResolvedValue([
            { flowId: 'vanished', journeyKey: 'onboarding' },
        ]);
        flowsRepoMock.getByGuildId.mockResolvedValue([]);

        const body = (await (await app().request(`/${GUILD_ID}/journeys`)).json()) as {
            journeys: { attachedFlows: { flowId: string; name: string }[] }[];
        };

        // A dangling link still blocks the delete, so hiding it here would make the
        // refusal name a flow the list never showed.
        expect(body.journeys[0].attachedFlows).toEqual([
            { flowId: 'vanished', name: 'vanished' },
        ]);
    });
});
