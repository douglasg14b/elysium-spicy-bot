import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FlowButtonMessagesRepo } from '../../../features/flows/data/flowButtonMessagesRepo';
import type { FlowButtonMessageEntity } from '../../../features/flows/data/flowButtonMessagesSchema';
import type { FlowJourneyLinksRepo } from '../../../features/provisioning/data/flowJourneyLinksRepo';
import type { JourneysRepo } from '../../../features/provisioning/data/journeysRepo';
import type { JourneyEntity } from '../../../features/provisioning/data/journeysSchema';
import type { AppEnv } from '../../types';

/**
 * The journey-scoped teardown routes: `GET /journeys/:journeyKey/published`,
 * `POST .../undeploy` and `POST .../unpublish`.
 *
 * These exist because the flows page's group header was answering a question about a
 * **journey** by asking it of one member flow. The two differ in ways an operator can
 * see, and each difference is a case below:
 *
 *  - **the button fan-out**, where a journey's inventory covers every attached flow's
 *    posted messages and the flow-scoped route covers one flow's, and
 *  - **the absent 409**, which is the entire point of the slice. A flow may not tear
 *    down a journey its siblings still install — that refusal protects flows the
 *    operator cannot see. Acting on the journey itself is the case that refusal points
 *    them *towards*, so reproducing it here would make a shared journey impossible to
 *    uninstall from the one screen scoped to the decision.
 *
 * Guild scoping is the third: a key belonging to another guild must be a 404 and must
 * never confirm that guild's journey exists.
 *
 * The teardown *engine* is not retested here. Which resources a plan deletes and which
 * it refuses is settled against its own cases in provisioning's suites; driving it
 * again through HTTP would test `buildUnpublishPlan` twice and the routes once.
 */

const journeysRepoMock = {
    listByGuildId: vi.fn(),
    getByKey: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    deleteByKey: vi.fn(),
} satisfies Record<
    keyof Pick<JourneysRepo, 'listByGuildId' | 'getByKey' | 'create' | 'update' | 'deleteByKey'>,
    unknown
>;

class DuplicateJourneyKeyError extends Error {}

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
} satisfies Record<
    keyof Pick<
        FlowJourneyLinksRepo,
        'getJourneyKeyForFlow' | 'listFlowIdsForJourney' | 'listLinksForGuild' | 'attach' | 'detachFlow'
    >,
    unknown
>;

vi.mock('../../../features/provisioning/data/flowJourneyLinksRepo', () => ({
    flowJourneyLinksRepo: linksRepo,
}));

const flowsRepoMock = {
    getByFlowId: vi.fn(),
    getByGuildId: vi.fn(),
};

vi.mock('../../../features/flows/data/flowsRepo', () => ({ flowsRepo: flowsRepoMock }));

/**
 * The button-message table, mocked because the published route reads it per attached
 * flow — that per-flow read *is* the fan-out these tests are here to pin down.
 */
const buttonMessagesRepo = {
    listByFlowId: vi.fn(),
    persist: vi.fn(),
    forget: vi.fn(),
} satisfies Record<keyof Pick<FlowButtonMessagesRepo, 'listByFlowId' | 'persist' | 'forget'>, unknown>;

vi.mock('../../../features/flows/data/flowButtonMessagesRepo', () => ({
    flowButtonMessagesRepo: buttonMessagesRepo,
}));

/**
 * The provisioning engine, stubbed at the service boundary.
 *
 * `previewUnpublish` and `unpublishJourney` are already journey-keyed and settled
 * elsewhere; what these tests own is whether the routes *reach* them, with which key,
 * and what they do with the answer. Stubbing here rather than mocking the bindings repo
 * keeps the assertions about the route rather than about plan arithmetic.
 */
const previewUnpublishMock = vi.fn();
const unpublishJourneyMock = vi.fn();

vi.mock('../../../features/provisioning', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../../features/provisioning')>();
    return {
        ...actual,
        previewUnpublish: previewUnpublishMock,
        unpublishJourney: unpublishJourneyMock,
    };
});

/** The button teardown, stubbed so the fan-out is observable without a Discord guild. */
const undeployFlowButtonsMock = vi.fn();

vi.mock('../../../features/flows/logic/undeployFlowButtons', () => ({
    undeployFlowButtons: undeployFlowButtonsMock,
}));

const { journeyRoutes } = await import('../journeyRoutes');

const GUILD_ID = 'guild-1';
const JOURNEY_KEY = 'onboarding';
const FLOW_A = '11111111-2222-3333-4444-555555555555';
const FLOW_B = '99999999-8888-7777-6666-555555555555';

function journeyRow(overrides: Partial<JourneyEntity> = {}): JourneyEntity {
    return {
        id: 1,
        journeyKey: JOURNEY_KEY,
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

function buttonRow(overrides: Partial<FlowButtonMessageEntity> = {}): FlowButtonMessageEntity {
    return {
        id: 1,
        guildId: GUILD_ID,
        flowId: FLOW_A,
        channelId: '111111111111111111',
        messageId: '222222222222222222',
        nodeIds: ['node-1'],
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

function getPublished(journeyKey: string = JOURNEY_KEY) {
    return app().request(`/${GUILD_ID}/journeys/${journeyKey}/published`);
}

function post(action: 'undeploy' | 'unpublish', journeyKey: string = JOURNEY_KEY) {
    return app().request(`/${GUILD_ID}/journeys/${journeyKey}/${action}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
    });
}

/**
 * The guild-scoped repo, honestly modelled: `getByKey` answers only for rows in the
 * guild it is asked about.
 *
 * A blanket `mockResolvedValue(journeyRow())` would return another guild's journey for
 * any key, which is exactly the leak the cross-guild cases assert against — the test
 * would pass while proving nothing.
 */
function journeyExists(rows: readonly JourneyEntity[]): void {
    journeysRepoMock.getByKey.mockImplementation(async (guildId: string, journeyKey: string) =>
        rows.find((row) => row.guildId === guildId && row.journeyKey === journeyKey) ?? null
    );
}

beforeEach(() => {
    vi.clearAllMocks();
    journeyExists([journeyRow()]);
    linksRepo.listFlowIdsForJourney.mockResolvedValue([]);
    buttonMessagesRepo.listByFlowId.mockResolvedValue([]);
    previewUnpublishMock.mockResolvedValue({ journeyKey: JOURNEY_KEY, items: [] });
    unpublishJourneyMock.mockResolvedValue({ results: [] });
    undeployFlowButtonsMock.mockResolvedValue({ results: [] });
});

describe('GET /journeys/:journeyKey/published', () => {
    it('404s for a journey that does not exist', async () => {
        journeyExists([]);

        const response = await getPublished('no-such-journey');

        expect(response.status).toBe(404);
        // Nothing was planned: a 404 must not have reached the teardown engine at all.
        expect(previewUnpublishMock).not.toHaveBeenCalled();
    });

    it('404s for a journey belonging to another guild, without confirming it exists', async () => {
        journeyExists([journeyRow({ guildId: 'someone-elses-guild', journeyKey: 'their-journey' })]);

        const response = await getPublished('their-journey');

        expect(response.status).toBe(404);
        // Byte-identical to the unknown-key refusal. A distinct message — or a 403 —
        // would tell an attacker which keys exist in guilds they cannot see.
        expect(await response.json()).toEqual({ error: 'Journey not found.' });
    });

    it('reports the journey state, planning against the journey key', async () => {
        const response = await getPublished();

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({
            buttonMessages: [],
            deletableResources: [],
            refusedResources: [],
            mayHaveUnrecordedButtons: true,
        });
        expect(previewUnpublishMock).toHaveBeenCalledWith(
            expect.objectContaining({ id: GUILD_ID }),
            JOURNEY_KEY
        );
    });

    /**
     * The fan-out, and the defect that motivated the whole slice.
     *
     * Opening this inventory through `flows[0]` showed flow A's message and not flow
     * B's, beside an uninstall that would have taken both down. The route must read
     * every attached flow.
     */
    it('includes the button messages of every attached flow', async () => {
        linksRepo.listFlowIdsForJourney.mockResolvedValue([FLOW_A, FLOW_B]);
        buttonMessagesRepo.listByFlowId.mockImplementation(async (_guildId: string, flowId: string) =>
            flowId === FLOW_A
                ? [buttonRow()]
                : [buttonRow({ id: 2, flowId: FLOW_B, messageId: '333333333333333333' })]
        );

        const response = await getPublished();
        const body = (await response.json()) as { buttonMessages: { messageId: string }[] };

        expect(body.buttonMessages.map((message) => message.messageId)).toEqual([
            '222222222222222222',
            '333333333333333333',
        ]);
    });
});

describe('POST /journeys/:journeyKey/undeploy', () => {
    it('404s for an unknown journey and retires nothing', async () => {
        journeyExists([]);

        const response = await post('undeploy', 'no-such-journey');

        expect(response.status).toBe(404);
        expect(undeployFlowButtonsMock).not.toHaveBeenCalled();
    });

    it('404s for another guild’s journey', async () => {
        journeyExists([journeyRow({ guildId: 'someone-elses-guild', journeyKey: 'their-journey' })]);

        const response = await post('undeploy', 'their-journey');

        expect(response.status).toBe(404);
        expect(undeployFlowButtonsMock).not.toHaveBeenCalled();
    });

    it('retires the buttons of every attached flow and reports them as one list', async () => {
        linksRepo.listFlowIdsForJourney.mockResolvedValue([FLOW_A, FLOW_B]);
        undeployFlowButtonsMock.mockImplementation(async (_guildId: string, flowId: string) => ({
            results: [
                {
                    channelId: '111111111111111111',
                    messageId: flowId === FLOW_A ? 'msg-a' : 'msg-b',
                    outcome: 'removed' as const,
                },
            ],
        }));

        const response = await post('undeploy');

        expect(response.status).toBe(200);
        expect(undeployFlowButtonsMock).toHaveBeenCalledWith(GUILD_ID, FLOW_A);
        expect(undeployFlowButtonsMock).toHaveBeenCalledWith(GUILD_ID, FLOW_B);
        const body = (await response.json()) as { results: { messageId: string }[] };
        expect(body.results.map((result) => result.messageId)).toEqual(['msg-a', 'msg-b']);
    });

    /**
     * One flow throwing must not discard what the others already did.
     *
     * `undeployFlowButtons` loops message by message and carries on past a failure, on
     * the stated grounds that buttons in one channel have nothing to do with buttons in
     * another. Fanning out with `Promise.all` would invert that a level up: the first
     * rejection throws away every sibling's report, including deletions that already
     * happened in Discord — and those rows are the only record of where the remaining
     * live buttons are.
     */
    it('reports a flow that throws as a failure and still retires the rest', async () => {
        linksRepo.listFlowIdsForJourney.mockResolvedValue([FLOW_A, FLOW_B]);
        undeployFlowButtonsMock.mockImplementation(async (_guildId: string, flowId: string) => {
            if (flowId === FLOW_A) throw new Error('database went away');
            return {
                results: [
                    { channelId: '111111111111111111', messageId: 'msg-b', outcome: 'removed' as const },
                ],
            };
        });

        const response = await post('undeploy');

        expect(response.status).toBe(200);
        const body = (await response.json()) as {
            results: { messageId: string; outcome: string; explanation?: string }[];
        };
        expect(body.results).toHaveLength(2);
        expect(body.results[0].outcome).toBe('failed');
        // The failure names the flow, which is the only thing an operator can act on
        // when there is no channel or message id to report.
        expect(body.results[0].explanation).toContain(FLOW_A);
        expect(body.results[0].explanation).toContain('database went away');
        // The sibling's deletion survived the throw.
        expect(body.results[1]).toMatchObject({ messageId: 'msg-b', outcome: 'removed' });
    });
});

describe('POST /journeys/:journeyKey/unpublish', () => {
    it('404s for an unknown journey and destroys nothing', async () => {
        journeyExists([]);

        const response = await post('unpublish', 'no-such-journey');

        expect(response.status).toBe(404);
        expect(unpublishJourneyMock).not.toHaveBeenCalled();
    });

    it('404s for another guild’s journey and destroys nothing', async () => {
        journeyExists([journeyRow({ guildId: 'someone-elses-guild', journeyKey: 'their-journey' })]);

        const response = await post('unpublish', 'their-journey');

        expect(response.status).toBe(404);
        expect(await response.json()).toEqual({ error: 'Journey not found.' });
        expect(unpublishJourneyMock).not.toHaveBeenCalled();
    });

    it('tears the journey down, applying a plan rebuilt on the server', async () => {
        const plan = { journeyKey: JOURNEY_KEY, items: [] };
        previewUnpublishMock.mockResolvedValue(plan);
        unpublishJourneyMock.mockResolvedValue({
            results: [
                { resourceKey: 'qa-channel', kind: 'textChannel', name: 'questions', outcome: 'deleted' },
            ],
        });

        const response = await post('unpublish');

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({
            results: [
                { resourceKey: 'qa-channel', kind: 'textChannel', name: 'questions', outcome: 'deleted' },
            ],
        });
        // The plan applied is the one this request just built, never one from the wire.
        expect(unpublishJourneyMock).toHaveBeenCalledWith({
            guild: expect.objectContaining({ id: GUILD_ID }),
            approvedPlan: plan,
        });
    });

    /**
     * **The point of the slice.**
     *
     * `POST /flows/:flowId/unpublish` refuses with a 409 when other flows share the
     * journey, because one flow may not destroy structure its siblings install. That
     * guard must not be reproduced here: an operator acting on the journey is the
     * legitimate case it was protecting against, and copying it would leave a shared
     * journey with no route that can uninstall it.
     */
    it('does NOT refuse when several flows share the journey', async () => {
        linksRepo.listFlowIdsForJourney.mockResolvedValue([FLOW_A, FLOW_B]);
        flowsRepoMock.getByFlowId.mockImplementation(async (flowId: string) => ({
            flowId,
            guildId: GUILD_ID,
            name: flowId === FLOW_A ? 'Welcome wagon' : 'Age check',
        }));

        const response = await post('unpublish');

        expect(response.status).toBe(200);
        expect(unpublishJourneyMock).toHaveBeenCalledTimes(1);
    });

    /** A refusal from the engine is still a 409 — that one is about the guild, not sharing. */
    it('passes an engine refusal through as a 409', async () => {
        unpublishJourneyMock.mockResolvedValue({
            refusal: 'The category **Questions** still contains channels we did not create.',
            results: [],
        });

        const response = await post('unpublish');

        expect(response.status).toBe(409);
        expect(await response.json()).toEqual({
            error: 'The category **Questions** still contains channels we did not create.',
        });
    });
});
