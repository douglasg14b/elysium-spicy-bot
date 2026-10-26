import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FLOW_GRAPH_VERSION, type FlowGraph } from '../../../features/flows/data/flowGraph';
import { ensureBlocksDiscovered } from '../../../features/flows/blocks/registry';
import type { FlowValidationIssue } from '../../../features/flows/engine/nodeDataValidation';
import type { ApiError } from '../../../../packages/web-sdk/src/apiError';
import type { FlowWriteDecision } from '../../../features/flows/data/flowsRepo';
import type { AppEnv } from '../../types';
import { fakeGuild } from '../../../features/flows/__tests__/support/fakeGuild';

/**
 * What `ApiError.issues` carries, held to the server's issue shape.
 *
 * It is the SDK's generated `FlowValidationIssue` — the spec's, which `flowBody.ts` holds
 * to the server's type — so this checks the end of that chain: what a page actually reads
 * off a refusal. Both directions, because one alone silently permits the other side to
 * grow a member. Read off `ApiError` by path, because the root resolves the SDK to its
 * contract alone, which has no client. Only root `tsc` sees these lines; Vitest does not
 * type-check this file.
 */
type SdkFlowValidationIssue = InstanceType<typeof ApiError>['issues'][number];

const serverIssueFitsSdk: SdkFlowValidationIssue = {} as FlowValidationIssue;
const sdkIssueFitsServer: FlowValidationIssue = {} as SdkFlowValidationIssue;
void serverIssueFitsSdk;
void sdkIssueFitsServer;

/**
 * What the save endpoint stores, refuses, and says about a graph's readiness.
 *
 * `flowRoutes()` is a bare Hono app — auth and guild resolution are applied where it
 * is mounted — so these inject a guild and focus on the things the route decides:
 * which graphs are stored, which switches are refused, and what each looks like on
 * the wire.
 *
 * The repos are mocked. Storage is settled elsewhere — including that `mutate` decides
 * against the row inside its own transaction, in `flowsRepo.test.ts` — and what is
 * under test here is that the route consults the flow's declarations before judging
 * its picker fields, and that an incomplete graph is stored or drafted according to
 * whether the flow is live. Drafts, uninstalled resources and the typed journey error
 * are exercised against a real database in `flowDraftRoutes.test.ts`.
 */

const flowsRepoMock = {
    getByFlowId: vi.fn(),
    getByGuildId: vi.fn(),
    countByGuildId: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    mutate: vi.fn(),
    deleteByFlowId: vi.fn(),
};

const journeysRepoMock = {
    getByKey: vi.fn(),
    listByGuildId: vi.fn(),
};

/**
 * Unattached by default, so these cases describe a flow whose journey is resolved by
 * the implicit key rule — which is what they were written against. Mocked rather than
 * left real because the real repo would reach the database these tests never set up.
 */
const flowJourneyLinksRepoMock = {
    getJourneyKeyForFlow: vi.fn().mockResolvedValue(null),
    listFlowIdsForJourney: vi.fn().mockResolvedValue([]),
    listLinksForGuild: vi.fn().mockResolvedValue([]),
    attach: vi.fn(),
    detachFlow: vi.fn(),
};

const resourceBindingsRepoMock = {
    listByGuild: vi.fn().mockResolvedValue([]),
};

vi.mock('../../../features/flows/data/flowsRepo', () => ({ flowsRepo: flowsRepoMock }));
// The real error class survives the mock: `readDeclarations` names only a malformed
// row, so a stand-in for one has to be the type the repo actually throws.
vi.mock('../../../features/provisioning/data/journeysRepo', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../../../features/provisioning/data/journeysRepo')>()),
    journeysRepo: journeysRepoMock,
}));
vi.mock('../../../features/provisioning/data/flowJourneyLinksRepo', () => ({
    flowJourneyLinksRepo: flowJourneyLinksRepoMock,
}));
vi.mock('../../../features/provisioning/data/resourceBindingsRepo', () => ({
    resourceBindingsRepo: resourceBindingsRepoMock,
}));

const { flowRoutes } = await import('../flowRoutes');
const { STALE_BUILDER_MESSAGE } = await import('../staleBuilderGraph');
const { guildUploadsRepo } = await import('../../../features-system/guild-uploads');
const { MalformedJourneyError } = await import('../../../features/provisioning/data/journeysRepo');

// The validators read the block registry.
await ensureBlocksDiscovered();

const GUILD_ID = 'guild-1';
const FLOW_ID = 'flow-1';
const EMPTY_GRAPH: FlowGraph = { version: FLOW_GRAPH_VERSION, nodes: [], edges: [] };

/** The one channel the guild holds — what an installed `qa-channel` resolved to. */
const INSTALLED_CHANNEL_ID = '111111111111111111';

/** A journey row the repo refused to read, as it now says so. */
function malformedJourney(): InstanceType<typeof MalformedJourneyError> {
    return new MalformedJourneyError(FLOW_ID, new Error('its resources column is not an array.'));
}

function app() {
    const outer = new Hono<AppEnv>();
    outer.use('*', async (c, next) => {
        c.set('guild', fakeGuild({ id: GUILD_ID, channels: { [INSTALLED_CHANNEL_ID]: {} } }));
        c.set('user', { id: 'operator-1', username: 'operator', avatar: null, manageableGuildIds: [GUILD_ID] });
        await next();
    });
    outer.route('/', flowRoutes());
    return outer;
}

function put(body: { graph?: FlowGraph; enabled?: boolean; name?: string }) {
    return app().request(`/${GUILD_ID}/flows/${FLOW_ID}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
    });
}

/** A one-node graph whose channel is empty and whose sidecar names `key`. */
function graphPicking(key: string | undefined): FlowGraph {
    return {
        version: FLOW_GRAPH_VERSION,
        nodes: [
            {
                id: 'send',
                type: 'action.sendMessage',
                position: { x: 0, y: 0 },
                data: {
                    channelId: '',
                    message: 'Hi',
                    ...(key === undefined ? {} : { channelIdKey: key }),
                },
            },
        ],
        edges: [],
    };
}

/** Sound, but its only node has no channel: incomplete, with exactly one issue. */
const INCOMPLETE_GRAPH = graphPicking(undefined);

/** One edge between nodes that are not there — refused before readiness is asked. */
const BROKEN_GRAPH: FlowGraph = {
    version: FLOW_GRAPH_VERSION,
    nodes: [],
    edges: [{ id: 'dangling', source: 'nowhere', target: 'nothing' }],
};

interface IssuesBody {
    error: string;
    issues: { nodeId?: string; field?: string; message: string }[];
}

interface DetailBody {
    enabled: boolean;
    graph: FlowGraph;
    issues: IssuesBody['issues'];
}

/** The stored row the route reads first. Disabled with an empty graph unless told otherwise. */
function storedFlow(overrides: { enabled?: boolean; graph?: FlowGraph } = {}) {
    return {
        flowId: FLOW_ID,
        guildId: GUILD_ID,
        name: 'Test',
        enabled: overrides.enabled ?? false,
        graph: overrides.graph ?? EMPTY_GRAPH,
        createdAt: new Date('2026-09-19T10:00:00Z'),
        updatedAt: new Date('2026-09-19T10:00:00Z'),
    };
}

/** Declare `qa-channel` on the flow's implicit journey. */
function declareQaChannel(): void {
    journeysRepoMock.getByKey.mockResolvedValue({
        journeyKey: FLOW_ID,
        resources: [{ key: 'qa-channel', kind: 'textChannel', defaultName: 'questions' }],
    });
}

beforeEach(() => {
    vi.clearAllMocks();
    // Re-stated after the clear, which drops implementations set at declaration.
    flowJourneyLinksRepoMock.getJourneyKeyForFlow.mockResolvedValue(null);
    flowJourneyLinksRepoMock.listFlowIdsForJourney.mockResolvedValue([]);
    flowJourneyLinksRepoMock.listLinksForGuild.mockResolvedValue([]);
    resourceBindingsRepoMock.listByGuild.mockResolvedValue([]);
    journeysRepoMock.listByGuildId.mockResolvedValue([]);
    journeysRepoMock.getByKey.mockResolvedValue(null);

    flowsRepoMock.getByFlowId.mockResolvedValue(storedFlow());
    // No other flows in the guild, so the loop check a switch-on or a live save asks
    // finds nothing — `flowLoopRoutes.test.ts` covers it against a real database.
    flowsRepoMock.getByGuildId.mockResolvedValue([]);
    // Far below the cap, so every create here is judged on its graph alone.
    flowsRepoMock.countByGuildId.mockResolvedValue(0);
    // Echoes the patch over the stored row, so a response reflects what was written.
    flowsRepoMock.update.mockImplementation(
        async (_flowId: string, patch: { graph?: FlowGraph; enabled?: boolean }) => {
            const stored = (await flowsRepoMock.getByFlowId()) as ReturnType<typeof storedFlow>;
            return { ...stored, graph: patch.graph ?? stored.graph, enabled: patch.enabled ?? stored.enabled };
        }
    );
    // The repo's contract in miniature: `check` sees the stored row, and only a
    // `write` reaches `update` — so "not stored" is still `update` never called.
    // A `draft` comes back as the untouched row, and `update` is still never called. What
    // the draft row holds is `flowDraftRoutes.test.ts`'s business, against a real database.
    flowsRepoMock.mutate.mockImplementation(
        async (flowId: string, check: (current: ReturnType<typeof storedFlow>) => FlowWriteDecision<unknown>) => {
            const current = (await flowsRepoMock.getByFlowId(flowId)) as ReturnType<typeof storedFlow> | null;
            if (!current) return { kind: 'missing' };
            const decision = check(current);
            if (decision.kind === 'refuse') return { kind: 'refused', refusal: decision.refusal };
            if (decision.kind === 'draft') {
                const now = new Date('2026-09-29T12:00:00Z');
                return {
                    kind: 'drafted',
                    flow: current,
                    draft: { id: 1, flowId, guildId: GUILD_ID, ...decision.draft, createdAt: now, updatedAt: now },
                };
            }
            return { kind: 'written', flow: await flowsRepoMock.update(flowId, decision.input) };
        }
    );
    flowsRepoMock.create.mockImplementation(async (input: { graph: FlowGraph; name: string }) => ({
        ...storedFlow({ graph: input.graph }),
        name: input.name,
    }));
});

// The uploads repo is real but never reached here: a case naming an upload spies on it.
afterEach(() => {
    vi.restoreAllMocks();
});

describe('saving a graph that picked a declared resource', () => {
    it('reports no issue for an empty picker field whose sidecar names a declared resource', async () => {
        declareQaChannel();

        const response = await put({ graph: graphPicking('qa-channel') });

        expect(response.status).toBe(200);
        expect(((await response.json()) as DetailBody).issues).toEqual([]);
        expect(flowsRepoMock.update).toHaveBeenCalled();
        // Keyed on the flow's own id: a flow's journey is implicit.
        expect(journeysRepoMock.getByKey).toHaveBeenCalledWith(GUILD_ID, FLOW_ID);
    });

    it('stores the same graph as incomplete when the flow declares nothing, naming the key', async () => {
        const response = await put({ graph: graphPicking('qa-channel') });

        expect(response.status).toBe(200);
        const body = (await response.json()) as DetailBody;
        expect(body.issues).toHaveLength(1);
        expect(body.issues[0]?.message).toContain('qa-channel');
        expect(flowsRepoMock.update).toHaveBeenCalled();
    });

    it('still counts an empty picker field with no sidecar at all as an issue', async () => {
        declareQaChannel();

        const response = await put({ graph: graphPicking(undefined) });

        expect(response.status).toBe(200);
        expect(((await response.json()) as DetailBody).issues).toHaveLength(1);
    });

    it('names the cause when the declarations cannot be read', async () => {
        // `journeysRepo` validates on read and throws on a malformed row. Left to
        // fall through, that is a bare 500 and the author is told to try again in a
        // second, forever, on a graph that is fine.
        journeysRepoMock.getByKey.mockRejectedValue(malformedJourney());

        const response = await put({ graph: graphPicking('qa-channel') });

        expect(response.status).toBe(500);
        const body = (await response.json()) as { error: string };
        // Names the journey, so the operator knows which row to look at — but not what
        // the validator said about it, which stays in the log.
        expect(body.error).toContain(`journey "${FLOW_ID}"`);
        expect(body.error).not.toContain('not an array');
        // Not recovered from by treating the flow as declaring nothing, which would
        // blame the author's graph for a data problem they cannot see.
        expect(flowsRepoMock.update).not.toHaveBeenCalled();
    });

    it('declares nothing for a flow that does not exist yet, and creates it incomplete', async () => {
        // POST judges a graph for a flow with no id, so there is no journey to read.
        // Nothing is declared, so a sidecar there names something undeclared — and a
        // new flow starts switched off, so that makes it incomplete, not refused.
        const response = await app().request(`/${GUILD_ID}/flows`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name: 'New', graph: graphPicking('qa-channel') }),
        });

        expect(response.status).toBe(201);
        const body = (await response.json()) as DetailBody;
        expect(body.issues).toHaveLength(1);
        expect(body.enabled).toBe(false);
        expect(journeysRepoMock.getByKey).not.toHaveBeenCalled();
        expect(flowsRepoMock.create).toHaveBeenCalled();
    });

    it('still refuses a structurally broken graph on create', async () => {
        const response = await app().request(`/${GUILD_ID}/flows`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name: 'New', graph: BROKEN_GRAPH }),
        });

        expect(response.status).toBe(400);
        expect(flowsRepoMock.create).not.toHaveBeenCalled();
    });
});

/*
 * One case per row of the save table. Each asserts both halves — the status and
 * whether anything was written — because "refused" and "not stored" are separate
 * claims and a route could make one without the other.
 */
describe('which graphs are stored, and which switches are refused', () => {
    it('refuses a structurally broken graph with 400 and stores nothing', async () => {
        const response = await put({ graph: BROKEN_GRAPH });

        expect(response.status).toBe(400);
        const body = (await response.json()) as IssuesBody;
        expect(body.issues.length).toBeGreaterThan(0);
        expect(flowsRepoMock.update).not.toHaveBeenCalled();
    });

    it('stores an incomplete graph on a switched-off flow, and returns its issues', async () => {
        const response = await put({ graph: INCOMPLETE_GRAPH });

        expect(response.status).toBe(200);
        const body = (await response.json()) as DetailBody;
        expect(body.issues).toEqual([expect.objectContaining({ nodeId: 'send', field: 'channelId' })]);
        expect(flowsRepoMock.update).toHaveBeenCalledWith(
            FLOW_ID,
            expect.objectContaining({ graph: INCOMPLETE_GRAPH })
        );
    });

    it('keeps an incomplete graph for a live flow as the saver’s draft, and stores nothing on the flow', async () => {
        flowsRepoMock.getByFlowId.mockResolvedValue(storedFlow({ enabled: true }));

        const response = await put({ graph: INCOMPLETE_GRAPH });

        expect(response.status).toBe(200);
        const body = (await response.json()) as DetailBody & {
            savedAs: string;
            draft: { authorId: string; issues: IssuesBody['issues'] };
        };
        expect(body.savedAs).toBe('draft');
        // The flow as it still is — live, on its old graph, which has nothing wrong with it.
        expect(body).toMatchObject({ enabled: true, graph: EMPTY_GRAPH, issues: [] });
        // The draft's issues are the canvas's: the graph that was sent.
        expect(body.draft).toMatchObject({ authorId: 'operator-1', issues: [expect.objectContaining({ nodeId: 'send' })] });
        expect(flowsRepoMock.update).not.toHaveBeenCalled();
    });

    it('treats an incomplete graph arriving with the switch on as a switch-on, and refuses it', async () => {
        // The flow is off, so this is not a live flow's edit and must not be told it is.
        const response = await put({ graph: INCOMPLETE_GRAPH, enabled: true });

        expect(response.status).toBe(400);
        expect(((await response.json()) as IssuesBody).error).toBe('Fix 1 problem before turning this flow on.');
        expect(flowsRepoMock.update).not.toHaveBeenCalled();
    });

    it('judges liveness from the row the write lands on, not the copy read before it', async () => {
        // Off when the route first looks, live by the time the transaction reads it —
        // a switch-on landing in between. Judged against the first read, the incomplete
        // graph would be stored onto a live flow.
        flowsRepoMock.getByFlowId
            .mockResolvedValueOnce(storedFlow())
            .mockResolvedValue(storedFlow({ enabled: true }));

        const response = await put({ graph: INCOMPLETE_GRAPH });

        expect(((await response.json()) as { savedAs: string }).savedAs).toBe('draft');
        expect(flowsRepoMock.update).not.toHaveBeenCalled();
    });

    it('stores an incomplete graph arriving with the switch that turns a live flow off', async () => {
        // Judged against the flow as it will be after this request, not as it is.
        flowsRepoMock.getByFlowId.mockResolvedValue(storedFlow({ enabled: true }));

        const response = await put({ graph: INCOMPLETE_GRAPH, enabled: false });

        expect(response.status).toBe(200);
        expect(((await response.json()) as DetailBody).enabled).toBe(false);
    });

    it('refuses to switch on a flow whose stored graph is incomplete, with its issues', async () => {
        flowsRepoMock.getByFlowId.mockResolvedValue(storedFlow({ graph: INCOMPLETE_GRAPH }));

        const response = await put({ enabled: true });

        expect(response.status).toBe(400);
        const body = (await response.json()) as IssuesBody;
        expect(body.error).toBe('Fix 1 problem before turning this flow on.');
        expect(body.issues).toEqual([expect.objectContaining({ nodeId: 'send', field: 'channelId' })]);
        expect(flowsRepoMock.update).not.toHaveBeenCalled();
    });

    it('switches on a flow whose stored graph is ready and installed', async () => {
        // Installed: the id is in, and the sidecar stays behind as install leaves it. An
        // empty field here would be ready but uninstalled, which is refused — see
        // `flowDraftRoutes.test.ts`.
        declareQaChannel();
        const installed = graphPicking('qa-channel');
        installed.nodes[0]!.data.channelId = INSTALLED_CHANNEL_ID;
        flowsRepoMock.getByFlowId.mockResolvedValue(storedFlow({ graph: installed }));

        const response = await put({ enabled: true });

        expect(response.status).toBe(200);
        const body = (await response.json()) as DetailBody;
        expect(body.enabled).toBe(true);
        expect(body.issues).toEqual([]);
    });

    it('always lets a flow be switched off, however incomplete it is', async () => {
        flowsRepoMock.getByFlowId.mockResolvedValue(storedFlow({ enabled: true, graph: INCOMPLETE_GRAPH }));

        const response = await put({ enabled: false });

        expect(response.status).toBe(200);
        const body = (await response.json()) as DetailBody;
        expect(body.enabled).toBe(false);
        // Still describes the stored graph, so the page learns it cannot switch back.
        expect(body.issues).toHaveLength(1);
    });

    it('switches a flow off even when its declarations cannot be read, and says it did', async () => {
        // The kill switch must not hang on a read it does not need. The response cannot
        // describe the stored graph without the declarations, so it is an error — but one
        // that says the write happened, so nobody retries a switch-off that landed.
        flowsRepoMock.getByFlowId.mockResolvedValue(storedFlow({ enabled: true }));
        journeysRepoMock.getByKey.mockRejectedValue(malformedJourney());

        const response = await put({ enabled: false });

        expect(flowsRepoMock.update).toHaveBeenCalledWith(FLOW_ID, expect.objectContaining({ enabled: false }));
        expect(response.status).toBe(500);
        expect(((await response.json()) as { error: string }).error).toMatch(/^Saved\. .*can't read/);
    });

    it('refuses to switch on while its declarations cannot be read, writing nothing', async () => {
        journeysRepoMock.getByKey.mockRejectedValue(malformedJourney());

        const response = await put({ enabled: true });

        expect(response.status).toBe(500);
        expect(flowsRepoMock.update).not.toHaveBeenCalled();
    });
});

describe('reading a flow', () => {
    it('carries the stored graph’s issues, so the builder opens with them marked', async () => {
        flowsRepoMock.getByFlowId.mockResolvedValue(storedFlow({ graph: INCOMPLETE_GRAPH }));

        const response = await app().request(`/${GUILD_ID}/flows/${FLOW_ID}`);

        expect(response.status).toBe(200);
        expect(((await response.json()) as DetailBody).issues).toEqual([
            expect.objectContaining({ nodeId: 'send', field: 'channelId' }),
        ]);
    });

    it('counts each row’s issues on the list, against that row’s own journey', async () => {
        // Both flows hold the same graph; only the second's journey declares the key its
        // sidecar names. The difference in count is the index's declarations at work.
        flowsRepoMock.getByGuildId.mockResolvedValue([
            { ...storedFlow({ graph: graphPicking('qa-channel') }), flowId: 'flow-undeclared' },
            { ...storedFlow({ graph: graphPicking('qa-channel') }), flowId: 'flow-declared' },
        ]);
        flowJourneyLinksRepoMock.listLinksForGuild.mockResolvedValue([
            { flowId: 'flow-declared', journeyKey: 'qa' },
        ]);
        journeysRepoMock.listByGuildId.mockResolvedValue([
            {
                journeyKey: 'qa',
                name: 'QA',
                resources: [{ key: 'qa-channel', kind: 'textChannel', defaultName: 'questions' }],
            },
        ]);

        const response = await app().request(`/${GUILD_ID}/flows`);

        expect(response.status).toBe(200);
        const body = (await response.json()) as { flows: Record<string, unknown>[] };
        expect(body.flows.map((flow) => [flow.flowId, flow.issueCount])).toEqual([
            ['flow-undeclared', 1],
            ['flow-declared', 0],
        ]);
        // The declarations stay off the wire; the row carries a count, not the keys.
        expect(body.flows[1]?.journey).not.toHaveProperty('declarations');
        expect(body.flows[1]?.journey).not.toHaveProperty('resources');
        // One index for the page, not a journey lookup per row.
        expect(journeysRepoMock.getByKey).not.toHaveBeenCalled();
    });

    it('judges a flow whose link names a deleted journey as declaring nothing, as its own GET does', async () => {
        // A journey keyed on the flow's id also exists. `resolveFlowJourney` does not fall
        // through to it once a link row exists, so neither may the list — or the row's
        // count would be judged against declarations the builder never sees.
        flowsRepoMock.getByGuildId.mockResolvedValue([storedFlow({ graph: graphPicking('qa-channel') })]);
        flowJourneyLinksRepoMock.listLinksForGuild.mockResolvedValue([{ flowId: FLOW_ID, journeyKey: 'deleted' }]);
        journeysRepoMock.listByGuildId.mockResolvedValue([
            {
                journeyKey: FLOW_ID,
                name: 'Implicit',
                resources: [{ key: 'qa-channel', kind: 'textChannel', defaultName: 'questions' }],
            },
        ]);

        const response = await app().request(`/${GUILD_ID}/flows`);
        const body = (await response.json()) as { flows: Record<string, unknown>[] };

        expect(body.flows[0]).toMatchObject({ issueCount: 1, journey: null });
    });
});

/*
 * The builder's re-check as a field loses focus. Every case asserts nothing was written:
 * that, not the answer, is what separates this route from a save.
 */
describe('checking a graph without saving it', () => {
    function check(body: unknown) {
        return app().request(`/${GUILD_ID}/flows/${FLOW_ID}/check`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
        });
    }

    function expectNothingWritten(): void {
        expect(flowsRepoMock.mutate).not.toHaveBeenCalled();
        expect(flowsRepoMock.update).not.toHaveBeenCalled();
    }

    it('answers with the issues a save of the graph would report', async () => {
        const response = await check({ graph: INCOMPLETE_GRAPH });

        expect(response.status).toBe(200);
        expect(((await response.json()) as { issues: IssuesBody['issues'] }).issues).toEqual([
            expect.objectContaining({ nodeId: 'send', field: 'channelId' }),
        ]);
        expectNothingWritten();
    });

    it('judges the sent graph, not the stored one', async () => {
        // Stored incomplete, sent finished: the answer is about what the author has now.
        flowsRepoMock.getByFlowId.mockResolvedValue(storedFlow({ graph: INCOMPLETE_GRAPH }));
        declareQaChannel();

        const response = await check({ graph: graphPicking('qa-channel') });

        expect(response.status).toBe(200);
        expect(((await response.json()) as { issues: unknown[] }).issues).toEqual([]);
        expectNothingWritten();
    });

    it('refuses a structurally broken graph with its issues, as a save would', async () => {
        const response = await check({ graph: BROKEN_GRAPH });

        expect(response.status).toBe(400);
        expect(((await response.json()) as IssuesBody).issues.length).toBeGreaterThan(0);
        expectNothingWritten();
    });

    it('does not confirm another guild’s flow exists', async () => {
        flowsRepoMock.getByFlowId.mockResolvedValue({ ...storedFlow(), guildId: 'other-guild' });

        const response = await check({ graph: INCOMPLETE_GRAPH });

        expect(response.status).toBe(404);
        expectNothingWritten();
    });

    it('names the cause when the declarations cannot be read', async () => {
        journeysRepoMock.getByKey.mockRejectedValue(malformedJourney());

        const response = await check({ graph: graphPicking('qa-channel') });

        expect(response.status).toBe(500);
        expect(((await response.json()) as { error: string }).error).toContain(`journey "${FLOW_ID}"`);
    });
});

describe('what an incomplete save puts on the wire', () => {
    it('carries issues addressed to the node and field', async () => {
        const response = await put({ graph: INCOMPLETE_GRAPH });
        const body = (await response.json()) as DetailBody;

        expect(body.issues[0]?.nodeId).toBe('send');
        expect(body.issues[0]?.field).toBe('channelId');
    });

    it('reports an unknown block type as a node-level issue with no field', async () => {
        const graph: FlowGraph = {
            version: FLOW_GRAPH_VERSION,
            nodes: [{ id: 'mystery', type: 'action.nope', position: { x: 0, y: 0 }, data: {} }],
            edges: [],
        };

        const response = await put({ graph });
        const body = (await response.json()) as DetailBody;

        expect(body.issues[0]?.nodeId).toBe('mystery');
        expect(body.issues[0]?.field).toBeUndefined();
    });

    it('addresses an authoring-rule issue to the node it is about, so its card can be marked', async () => {
        // Fan-out: two edges on one handle. Every field is fine, so the only issue is the
        // authoring rule — which used to arrive with no node, marking no card at all.
        const graph: FlowGraph = {
            version: FLOW_GRAPH_VERSION,
            nodes: [
                { id: 'join', type: 'trigger.memberJoin', position: { x: 0, y: 0 }, data: {} },
                { id: 'dm-a', type: 'action.sendDM', position: { x: 0, y: 100 }, data: { message: 'A' } },
                { id: 'dm-b', type: 'action.sendDM', position: { x: 0, y: 200 }, data: { message: 'B' } },
            ],
            edges: [
                { id: 'join-a', source: 'join', target: 'dm-a' },
                { id: 'join-b', source: 'join', target: 'dm-b' },
            ],
        };

        const response = await put({ graph });
        const body = (await response.json()) as DetailBody;

        expect(body.issues).toEqual([expect.objectContaining({ nodeId: 'join' })]);
        expect(body.issues[0]?.message).toMatch(/2 edges leaving/);
    });

    it('refuses a whole-graph problem with no node to blame, and the legacy error string', async () => {
        const response = await put({ graph: BROKEN_GRAPH });
        const body = (await response.json()) as IssuesBody;

        expect(body.issues[0]?.nodeId).toBeUndefined();
        // `error` is what every existing client reads and `ApiError` falls back to.
        // Dropping it would break them for no gain, so it is asserted, not assumed.
        expect(body.error).toContain('dangling');
    });
});

/*
 * What the request validator refuses before a handler runs. The routes are declared with
 * their bodies, so the body is checked first — before the flow is looked up — and every
 * refusal still arrives in the `{ error }` envelope the dashboard reads.
 */
describe('a request body the validator refuses', () => {
    function send(path: string, init: { method: string; contentType: string; body: string }) {
        return app().request(`/${GUILD_ID}/flows/${path}`, {
            method: init.method,
            headers: { 'content-type': init.contentType },
            body: init.body,
        });
    }

    it('answers a body that is not sent as JSON with 415, and writes nothing', async () => {
        const response = await send(FLOW_ID, {
            method: 'PUT',
            contentType: 'text/plain',
            body: JSON.stringify({ enabled: true }),
        });

        expect(response.status).toBe(415);
        expect(((await response.json()) as { error: string }).error).toBeTruthy();
        expect(flowsRepoMock.mutate).not.toHaveBeenCalled();
    });

    it('answers malformed JSON with 400 and the sentence that says so', async () => {
        const response = await send(FLOW_ID, { method: 'PUT', contentType: 'application/json', body: '{"enabled": tru' });

        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({ error: 'Malformed JSON in request body' });
        expect(flowsRepoMock.mutate).not.toHaveBeenCalled();
    });

    it("sends the schema's own sentence for a field it refuses", async () => {
        const response = await send(FLOW_ID, { method: 'PUT', contentType: 'application/json', body: '{"name":""}' });

        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({ error: 'Give the flow a name.' });
    });

    it.each([
        { route: 'update', method: 'PUT', path: 'no-such-flow' },
        { route: 'check', method: 'POST', path: 'no-such-flow/check' },
    ])('refuses a bad $route body before looking the flow up', async ({ method, path }) => {
        flowsRepoMock.getByFlowId.mockResolvedValue(null);

        const response = await send(path, { method, contentType: 'application/json', body: '{"graph":"not a graph"}' });

        expect(response.status).toBe(400);
        expect(flowsRepoMock.getByFlowId).not.toHaveBeenCalled();
    });
});

describe('a flow switched on by someone else while a save was on its way', () => {
    it('refuses the save rather than let a graph go live without the loop check', async () => {
        // The route reads the row off, so it skips reading the guild's live flows; by the
        // time the write's transaction sees the row, another request has switched it on,
        // and this graph would go live. The check is owed and cannot be made.
        flowsRepoMock.getByFlowId
            .mockResolvedValueOnce(storedFlow({ enabled: false }))
            .mockResolvedValueOnce(storedFlow({ enabled: true }));

        const response = await put({ graph: EMPTY_GRAPH });

        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({
            error: 'This flow was switched on or off while you were saving. Save again.',
            issues: [],
        });
        expect(flowsRepoMock.getByGuildId).not.toHaveBeenCalled();
        expect(flowsRepoMock.update).not.toHaveBeenCalled();
    });
});

const UPLOAD_ID = '0f0e0d0c-0b0a-4908-8706-050403020100';
const OTHER_UPLOAD_ID = '1f1e1d1c-1b1a-4918-9716-151413121110';

/** Post Embed into the guild's channel, its image the upload `uploadId`. */
function postingUpload(uploadId: string): FlowGraph {
    return {
        version: FLOW_GRAPH_VERSION,
        nodes: [
            {
                id: 'post',
                type: 'action.postEmbed',
                position: { x: 0, y: 0 },
                data: {
                    channelId: INSTALLED_CHANNEL_ID,
                    message: { embeds: [{ title: 'New', image: `upload:${uploadId}` }] },
                },
            },
        ],
        edges: [],
    };
}

/**
 * The route reads what the guild holds of the uploads the row names as it read it — none —
 * before the transaction, which may not query. By the time the transaction sees the row,
 * another save has given it an upload that read was never asked about.
 */
describe('a stored graph that gained an upload while a save was on its way', () => {
    /**
     * The row as the route reads it first, then as the transaction sees it — and, for a write
     * that goes through, as `update` echoes it back.
     */
    function raceToUpload(written: 'refused' | 'written'): void {
        const gained = storedFlow({ enabled: false, graph: postingUpload(UPLOAD_ID) });
        flowsRepoMock.getByFlowId.mockResolvedValueOnce(storedFlow({ enabled: false })).mockResolvedValueOnce(gained);
        if (written === 'written') {
            flowsRepoMock.getByFlowId.mockResolvedValueOnce(gained);
        }
    }

    it('refuses the switch-on with a "save again" rather than calling the picture missing', async () => {
        raceToUpload('refused');

        const response = await put({ enabled: true });

        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({
            error: 'This flow changed while you were saving. Save again.',
            issues: [],
        });
        expect(flowsRepoMock.update).not.toHaveBeenCalled();
    });

    it.each([
        ['a switch-off', { enabled: false }],
        ['a rename', { name: 'Renamed' }],
    ])('writes %s all the same, which is never refused, and describes the graph it leaves', async (_request, body) => {
        raceToUpload('written');
        // This server holds no such upload. Read once, after the write, for the graph as written.
        const sizesFor = vi.spyOn(guildUploadsRepo, 'sizesFor').mockResolvedValue([]);

        const response = await put(body);

        expect(response.status).toBe(200);
        expect(flowsRepoMock.update).toHaveBeenCalledTimes(1);
        expect(sizesFor).toHaveBeenCalledTimes(1);
        expect(((await response.json()) as DetailBody).issues).toEqual([
            { nodeId: 'post', field: 'message.embeds.0.image', message: expect.stringMatching(/isn't in this server/) },
        ]);
    });
});

describe('what a save reads of the uploads', () => {
    it('reads only the uploads the arriving graph names, once, and reuses that for the answer', async () => {
        // Stored with one upload, sent with another: only the one being judged is read.
        flowsRepoMock.getByFlowId.mockResolvedValue(storedFlow({ graph: postingUpload(OTHER_UPLOAD_ID) }));
        const sizesFor = vi
            .spyOn(guildUploadsRepo, 'sizesFor')
            .mockResolvedValue([{ uploadId: UPLOAD_ID, byteSize: 1024 }]);

        const response = await put({ graph: postingUpload(UPLOAD_ID) });

        expect(response.status).toBe(200);
        expect(((await response.json()) as DetailBody).issues).toEqual([]);
        expect(sizesFor.mock.calls).toEqual([[GUILD_ID, [UPLOAD_ID]]]);
    });
});

describe('a save from a builder tab older than the Post Embed editor', () => {
    /** Post Embed as the old builder wrote it: flat keys, no `message`. */
    const FLAT_GRAPH: FlowGraph = {
        version: FLOW_GRAPH_VERSION,
        nodes: [
            {
                id: 'post',
                type: 'action.postEmbed',
                position: { x: 0, y: 0 },
                data: { channelId: INSTALLED_CHANNEL_ID, title: 'House Rules', description: 'Read them.', showTimestamp: 'false' },
            },
        ],
        edges: [],
    };
    const REFUSAL = { error: STALE_BUILDER_MESSAGE, issues: [{ nodeId: 'post', message: STALE_BUILDER_MESSAGE }] };

    it('is refused on a switched-off flow, where it would have overwritten the stored embed', async () => {
        const response = await put({ graph: FLAT_GRAPH });

        expect(response.status).toBe(400);
        expect(await response.json()).toEqual(REFUSAL);
        expect(flowsRepoMock.mutate).not.toHaveBeenCalled();
        expect(flowsRepoMock.update).not.toHaveBeenCalled();
    });

    it('is refused by create and by the check, as by the save', async () => {
        const created = await app().request(`/${GUILD_ID}/flows`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name: 'Old tab', graph: FLAT_GRAPH }),
        });
        const checked = await app().request(`/${GUILD_ID}/flows/${FLOW_ID}/check`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ graph: FLAT_GRAPH }),
        });

        expect(created.status).toBe(400);
        expect(await created.json()).toEqual(REFUSAL);
        expect(flowsRepoMock.create).not.toHaveBeenCalled();
        expect(checked.status).toBe(400);
        expect(await checked.json()).toEqual(REFUSAL);
    });

    it('stores a node that kept its message, dropping only the stale keys beside it', async () => {
        const graph = postingUpload(UPLOAD_ID);
        graph.nodes[0]!.data.title = 'An old tab’s edit';
        vi.spyOn(guildUploadsRepo, 'sizesFor').mockResolvedValue([{ uploadId: UPLOAD_ID, byteSize: 1024 }]);

        const response = await put({ graph });

        expect(response.status).toBe(200);
        expect(flowsRepoMock.update).toHaveBeenCalledWith(
            FLOW_ID,
            expect.objectContaining({ graph: postingUpload(UPLOAD_ID) })
        );
    });

    it('lets a fresh Post Embed through, which holds neither shape yet', async () => {
        const graph: FlowGraph = {
            version: FLOW_GRAPH_VERSION,
            nodes: [{ id: 'post', type: 'action.postEmbed', position: { x: 0, y: 0 }, data: { channelId: '' } }],
            edges: [],
        };

        const response = await put({ graph });

        expect(response.status).toBe(200);
        expect(flowsRepoMock.update).toHaveBeenCalledTimes(1);
    });
});

describe('a save from a builder tab older than Button Click listening to a message', () => {
    /** Button Click as the old builder wrote it: a button of its own, no `button`. */
    const OWN_BUTTON_GRAPH: FlowGraph = {
        version: FLOW_GRAPH_VERSION,
        nodes: [
            {
                id: 'press',
                type: 'trigger.buttonClick',
                position: { x: 0, y: 0 },
                data: { channelId: INSTALLED_CHANNEL_ID, label: 'Agree to Rules', style: 'Success', eligibility: { principal: 'anyone' } },
            },
        ],
        edges: [],
    };
    const REFUSAL = { error: STALE_BUILDER_MESSAGE, issues: [{ nodeId: 'press', message: STALE_BUILDER_MESSAGE }] };

    it('is refused by the save, create and the check, writing nothing', async () => {
        const saved = await put({ graph: OWN_BUTTON_GRAPH });
        const created = await app().request(`/${GUILD_ID}/flows`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name: 'Old tab', graph: OWN_BUTTON_GRAPH }),
        });
        const checked = await app().request(`/${GUILD_ID}/flows/${FLOW_ID}/check`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ graph: OWN_BUTTON_GRAPH }),
        });

        expect(saved.status).toBe(400);
        expect(await saved.json()).toEqual(REFUSAL);
        expect(created.status).toBe(400);
        expect(await created.json()).toEqual(REFUSAL);
        expect(checked.status).toBe(400);
        expect(await checked.json()).toEqual(REFUSAL);
        expect(flowsRepoMock.mutate).not.toHaveBeenCalled();
        expect(flowsRepoMock.create).not.toHaveBeenCalled();
    });

    it('stores a node that names a button, dropping only the stale keys beside it', async () => {
        const graph: FlowGraph = {
            version: FLOW_GRAPH_VERSION,
            nodes: [
                {
                    id: 'press',
                    type: 'trigger.buttonClick',
                    position: { x: 0, y: 0 },
                    data: {
                        button: { messageKey: 'rules-panel', buttonKey: 'agree' },
                        label: 'An old tab’s edit',
                        eligibility: { principal: 'anyone' },
                    },
                },
            ],
            edges: [],
        };

        const response = await put({ graph });

        expect(response.status).toBe(200);
        const stored = flowsRepoMock.update.mock.calls[0]?.[1] as { graph: FlowGraph };
        expect(stored.graph.nodes[0]?.data).toEqual({
            button: { messageKey: 'rules-panel', buttonKey: 'agree' },
            eligibility: { principal: 'anyone' },
        });
    });
});

describe("a graph naming another server's channel", () => {
    /** Posts into a channel this guild does not hold — another server's, as far as it knows. */
    const FOREIGN_GRAPH: FlowGraph = {
        version: FLOW_GRAPH_VERSION,
        nodes: [
            {
                id: 'post',
                type: 'action.sendMessage',
                position: { x: 0, y: 0 },
                data: { channelId: '999999999999999999', message: 'Hello from elsewhere.' },
            },
        ],
        edges: [],
    };

    it('cannot be switched on, and the refusal marks the node and field', async () => {
        const response = await put({ graph: FOREIGN_GRAPH, enabled: true });

        expect(response.status).toBe(400);
        const body = (await response.json()) as IssuesBody;
        expect(body.issues).toEqual([
            { nodeId: 'post', field: 'channelId', message: expect.stringMatching(/isn't in this server/) },
        ]);
        expect(flowsRepoMock.update).not.toHaveBeenCalled();
    });

    it('is what the check says too, so the builder agrees with the save', async () => {
        const response = await app().request(`/${GUILD_ID}/flows/${FLOW_ID}/check`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ graph: FOREIGN_GRAPH }),
        });

        expect(response.status).toBe(200);
        expect(((await response.json()) as { issues: IssuesBody['issues'] }).issues).toEqual([
            { nodeId: 'post', field: 'channelId', message: expect.stringMatching(/isn't in this server/) },
        ]);
    });
});

describe('what a stored graph may hold', () => {
    function create(body: unknown) {
        return app().request(`/${GUILD_ID}/flows`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
        });
    }

    it('keeps only the keys each block declares, picker sidecars included', async () => {
        const graph = graphPicking('qa-channel');
        graph.nodes[0]!.data.smuggled = 'x'.repeat(1000);

        const response = await create({ name: 'New', graph });

        expect(response.status).toBe(201);
        const stored = flowsRepoMock.create.mock.calls[0]?.[0] as { graph: FlowGraph };
        expect(stored.graph.nodes[0]?.data).toEqual({ channelId: '', message: 'Hi', channelIdKey: 'qa-channel' });
    });

    it('keeps the keys an edit sends, minus what no block declares', async () => {
        const graph = graphPicking(undefined);
        graph.nodes[0]!.data.smuggled = true;

        const response = await put({ graph });

        expect(response.status).toBe(200);
        expect(flowsRepoMock.update).toHaveBeenCalledWith(
            FLOW_ID,
            expect.objectContaining({
                graph: expect.objectContaining({
                    nodes: [expect.objectContaining({ data: { channelId: '', message: 'Hi' } })],
                }),
            })
        );
    });

    it('refuses a graph of more blocks than any flow is built from', async () => {
        const nodes = Array.from({ length: 251 }, (_unused, index) => ({
            id: `node-${index}`,
            type: 'action.sendMessage',
            position: { x: 0, y: 0 },
            data: {},
        }));

        const response = await create({ name: 'Huge', graph: { version: FLOW_GRAPH_VERSION, nodes, edges: [] } });

        expect(response.status).toBe(400);
        expect(((await response.json()) as { error: string }).error).toMatch(/at most 250 blocks/);
        expect(flowsRepoMock.create).not.toHaveBeenCalled();
    });

    it('refuses a new flow once the server holds as many as it gets', async () => {
        flowsRepoMock.countByGuildId.mockResolvedValue(200);

        const response = await create({ name: 'One too many' });

        expect(response.status).toBe(400);
        expect(((await response.json()) as { error: string }).error).toMatch(/already has 200 flows/);
        expect(flowsRepoMock.countByGuildId).toHaveBeenCalledWith(GUILD_ID);
        expect(flowsRepoMock.create).not.toHaveBeenCalled();
    });
});
