import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FlowsRepo } from '../../../features/flows/data/flowsRepo';
import type { FlowJourneyLinksRepo } from '../../../features/provisioning/data/flowJourneyLinksRepo';
import type { JourneysRepo } from '../../../features/provisioning/data/journeysRepo';
import type { JourneyEntity } from '../../../features/provisioning/data/journeysSchema';
import type { ResourceBindingsRepo } from '../../../features/provisioning/data/resourceBindingsRepo';
import type { ResourceBindingEntity } from '../../../features/provisioning/data/resourceBindingsSchema';
import type { AppEnv } from '../../types';

/**
 * The install state the flows list carries on every row.
 *
 * **Why this is worth a route test rather than only a unit one.**
 * `summariseJourneyInstall` is settled against its own cases in
 * `provisioning/logic/__tests__/journeyInstallState.test.ts`, and re-asserting its
 * arithmetic here would test one pure function twice. What is only testable through the
 * route is the **join**: three independent queries — links, journeys, bindings — reconciled
 * into one answer per flow. The ways that goes wrong are all invisible to the pure function:
 *
 *  - bindings fetched per journey instead of once, which is the N+1 this shape exists to
 *    avoid and which no assertion about the *body* would ever notice;
 *  - one journey's bindings counted towards another's, which is live-possible because a
 *    resource key is only unique within a journey;
 *  - the pre-link fallback flows — resolved by the old convention, keyed on their own id —
 *    getting a membership with no install state, which is what the flows page reads.
 *
 * The chip the operator actually sees is `installChipFor` in `web/`, tested beside it.
 * This asserts the wire it reads from.
 */

const journeysRepoMock = {
    listByGuildId: vi.fn(),
    getByKey: vi.fn(),
} satisfies Record<keyof Pick<JourneysRepo, 'listByGuildId' | 'getByKey'>, unknown>;

const flowsRepoMock = {
    getByGuildId: vi.fn(),
    getByFlowId: vi.fn(),
} satisfies Record<keyof Pick<FlowsRepo, 'getByGuildId' | 'getByFlowId'>, unknown>;

const flowJourneyLinksRepoMock = {
    listLinksForGuild: vi.fn(),
    getJourneyKeyForFlow: vi.fn().mockResolvedValue(null),
    listFlowIdsForJourney: vi.fn().mockResolvedValue([]),
} satisfies Record<
    keyof Pick<
        FlowJourneyLinksRepo,
        'listLinksForGuild' | 'getJourneyKeyForFlow' | 'listFlowIdsForJourney'
    >,
    unknown
>;

const resourceBindingsRepoMock = {
    listByGuild: vi.fn(),
} satisfies Record<keyof Pick<ResourceBindingsRepo, 'listByGuild'>, unknown>;

vi.mock('../../../features/flows/data/flowsRepo', () => ({ flowsRepo: flowsRepoMock }));
vi.mock('../../../features/provisioning/data/journeysRepo', () => ({
    journeysRepo: journeysRepoMock,
}));
vi.mock('../../../features/provisioning/data/flowJourneyLinksRepo', () => ({
    flowJourneyLinksRepo: flowJourneyLinksRepoMock,
}));
vi.mock('../../../features/provisioning/data/resourceBindingsRepo', () => ({
    resourceBindingsRepo: resourceBindingsRepoMock,
}));

const { flowRoutes } = await import('../flowRoutes');

const GUILD_ID = 'guild-1';

function app() {
    const outer = new Hono<AppEnv>();
    outer.use('*', async (c, next) => {
        c.set('guild', { id: GUILD_ID } as never);
        await next();
    });
    outer.route('/', flowRoutes());
    return outer;
}

function flowRow(flowId: string, name: string) {
    return {
        flowId,
        guildId: GUILD_ID,
        name,
        enabled: true,
        graph: { version: 1, nodes: [], edges: [] },
        createdAt: new Date('2026-09-01T00:00:00.000Z'),
        updatedAt: new Date('2026-09-01T00:00:00.000Z'),
    };
}

function journeyRow(journeyKey: string, resourceKeys: readonly string[]): JourneyEntity {
    return {
        id: 1,
        guildId: GUILD_ID,
        journeyKey,
        name: journeyKey,
        description: null,
        resources: resourceKeys.map((key) => ({
            key,
            kind: 'textChannel' as const,
            defaultName: key,
        })),
        createdForFlowId: null,
        createdAt: new Date('2026-09-01T00:00:00.000Z'),
        updatedAt: new Date('2026-09-01T00:00:00.000Z'),
    };
}

function bindingRow(
    journeyKey: string,
    resourceKey: string,
    overrides: Partial<ResourceBindingEntity> = {}
): ResourceBindingEntity {
    return {
        id: 1,
        guildId: GUILD_ID,
        journeyKey,
        resourceKey,
        kind: 'textChannel',
        state: 'created',
        discordId: '900',
        name: resourceKey,
        createdAt: new Date('2026-09-01T00:00:00.000Z'),
        updatedAt: new Date('2026-09-01T00:00:00.000Z'),
        ...overrides,
    };
}

/** The slice of the list body these cases read — the membership on each row. */
interface ListedFlow {
    readonly flowId: string;
    readonly journey: {
        readonly installState: string;
        readonly installedCount: number;
        readonly resourceCount: number;
    } | null;
}

async function listFlows(): Promise<{ flows: ListedFlow[] }> {
    const response = await app().request(`/${GUILD_ID}/flows`);
    expect(response.status).toBe(200);
    // `Response.json()` is `unknown` by design — it is a network boundary. Named here
    // rather than asserted at each call site, which is where a wrong shape would go
    // unnoticed across seven cases.
    return (await response.json()) as { flows: ListedFlow[] };
}

beforeEach(() => {
    vi.clearAllMocks();
    flowJourneyLinksRepoMock.listLinksForGuild.mockResolvedValue([]);
    resourceBindingsRepoMock.listByGuild.mockResolvedValue([]);
    journeysRepoMock.listByGuildId.mockResolvedValue([]);
});

describe('GET /flows — install state', () => {
    it('reports a journey whose declarations are all bound as installed', async () => {
        flowsRepoMock.getByGuildId.mockResolvedValue([flowRow('flow-a', 'A'), flowRow('flow-b', 'B')]);
        flowJourneyLinksRepoMock.listLinksForGuild.mockResolvedValue([
            { flowId: 'flow-a', journeyKey: 'onboarding' },
            { flowId: 'flow-b', journeyKey: 'onboarding' },
        ]);
        journeysRepoMock.listByGuildId.mockResolvedValue([
            journeyRow('onboarding', ['welcome', 'rules']),
        ]);
        resourceBindingsRepoMock.listByGuild.mockResolvedValue([
            bindingRow('onboarding', 'welcome'),
            bindingRow('onboarding', 'rules', { id: 2, discordId: '901' }),
        ]);

        const { flows } = await listFlows();

        // Both members carry the same answer: install state is a property of the journey,
        // and a header and its rows disagreeing would be a group describing itself twice.
        for (const flow of flows) {
            expect(flow.journey).toMatchObject({
                installState: 'all',
                installedCount: 2,
                resourceCount: 2,
            });
        }
    });

    it('reports a half-installed journey as partial', async () => {
        flowsRepoMock.getByGuildId.mockResolvedValue([flowRow('flow-a', 'A')]);
        flowJourneyLinksRepoMock.listLinksForGuild.mockResolvedValue([
            { flowId: 'flow-a', journeyKey: 'onboarding' },
        ]);
        journeysRepoMock.listByGuildId.mockResolvedValue([
            journeyRow('onboarding', ['welcome', 'rules', 'verified']),
        ]);
        resourceBindingsRepoMock.listByGuild.mockResolvedValue([bindingRow('onboarding', 'welcome')]);

        const { flows } = await listFlows();

        expect(flows[0]?.journey).toMatchObject({ installState: 'partial', installedCount: 1 });
    });

    it('does not credit one journey with another journey\'s bindings', async () => {
        // A resource key is unique only *within* a journey, so two journeys declaring
        // `welcome` is ordinary. Grouping the bindings wrongly would report a journey as
        // installed on the strength of a channel belonging to a different one.
        flowsRepoMock.getByGuildId.mockResolvedValue([flowRow('flow-a', 'A'), flowRow('flow-b', 'B')]);
        flowJourneyLinksRepoMock.listLinksForGuild.mockResolvedValue([
            { flowId: 'flow-a', journeyKey: 'onboarding' },
            { flowId: 'flow-b', journeyKey: 'tickets' },
        ]);
        journeysRepoMock.listByGuildId.mockResolvedValue([
            journeyRow('onboarding', ['welcome']),
            journeyRow('tickets', ['welcome']),
        ]);
        resourceBindingsRepoMock.listByGuild.mockResolvedValue([
            bindingRow('onboarding', 'welcome'),
        ]);

        const { flows } = await listFlows();
        const byId = new Map(flows.map((flow) => [flow.flowId, flow]));

        expect(byId.get('flow-a')?.journey).toMatchObject({ installState: 'all' });
        expect(byId.get('flow-b')?.journey).toMatchObject({ installState: 'none' });
    });

    it('does not count an `intended` binding, which is a failed install', async () => {
        flowsRepoMock.getByGuildId.mockResolvedValue([flowRow('flow-a', 'A')]);
        flowJourneyLinksRepoMock.listLinksForGuild.mockResolvedValue([
            { flowId: 'flow-a', journeyKey: 'onboarding' },
        ]);
        journeysRepoMock.listByGuildId.mockResolvedValue([journeyRow('onboarding', ['welcome'])]);
        resourceBindingsRepoMock.listByGuild.mockResolvedValue([
            bindingRow('onboarding', 'welcome', { state: 'intended', discordId: null }),
        ]);

        const { flows } = await listFlows();

        expect(flows[0]?.journey).toMatchObject({ installState: 'none', installedCount: 0 });
    });

    it('answers for a flow resolved by the pre-link fallback', async () => {
        // A flow predating the link table has no link row; its journey is keyed on its own
        // id. Those rows must carry an install state like any other, or the page shows a
        // chip for some flows and nothing for others with no rule the operator can see.
        flowsRepoMock.getByGuildId.mockResolvedValue([flowRow('legacy-flow', 'Legacy')]);
        journeysRepoMock.listByGuildId.mockResolvedValue([
            journeyRow('legacy-flow', ['welcome', 'rules']),
        ]);
        resourceBindingsRepoMock.listByGuild.mockResolvedValue([
            bindingRow('legacy-flow', 'welcome'),
        ]);

        const { flows } = await listFlows();

        expect(flows[0]?.journey).toMatchObject({ installState: 'partial', installedCount: 1 });
    });

    it('asks for the guild\'s bindings once, not once per journey', async () => {
        // The N+1 this shape exists to avoid, and the one defect here that no assertion
        // about the response body could ever catch.
        flowsRepoMock.getByGuildId.mockResolvedValue([
            flowRow('flow-a', 'A'),
            flowRow('flow-b', 'B'),
            flowRow('flow-c', 'C'),
        ]);
        flowJourneyLinksRepoMock.listLinksForGuild.mockResolvedValue([
            { flowId: 'flow-a', journeyKey: 'one' },
            { flowId: 'flow-b', journeyKey: 'two' },
            { flowId: 'flow-c', journeyKey: 'three' },
        ]);
        journeysRepoMock.listByGuildId.mockResolvedValue([
            journeyRow('one', ['a']),
            journeyRow('two', ['b']),
            journeyRow('three', ['c']),
        ]);

        await listFlows();

        expect(resourceBindingsRepoMock.listByGuild).toHaveBeenCalledTimes(1);
        expect(resourceBindingsRepoMock.listByGuild).toHaveBeenCalledWith(GUILD_ID);
    });

    it('leaves a flow with no journey null rather than inventing a state', async () => {
        flowsRepoMock.getByGuildId.mockResolvedValue([flowRow('flow-a', 'A')]);

        const { flows } = await listFlows();

        expect(flows[0]?.journey).toBeNull();
    });
});
