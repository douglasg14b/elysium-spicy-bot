import { Hono } from 'hono';
import { sql } from 'kysely';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ensureBlocksDiscovered } from '../../../features/flows/blocks/registry';
import { FLOW_GRAPH_VERSION, type FlowGraph } from '../../../features/flows/data/flowGraph';
import { flowJourneyLinksRepo, journeysRepo } from '../../../features/provisioning';
import { database } from '../../../features-system/data-persistence/database';
import { migrateTestDatabase } from '../../../features-system/data-persistence/__tests__/support/migrateTestDatabase';
import type { AppEnv } from '../../types';
import { flowRoutes } from '../flowRoutes';

/**
 * Drafts, and the two switch-on and journey-read changes that shipped with them, through
 * the real routes, repos and an in-memory sqlite built by the real migrations.
 *
 * Real rather than mocked because what these assert is what the database ends up
 * holding — that the live row was *not* written, that one author's draft went and
 * another's stayed — and a mocked repo can only echo back what the test told it. Each
 * case makes its own flow, so the shared database never couples two of them.
 */

const GUILD_ID = 'guild-1';
const ALICE = { id: 'user-alice', username: 'alice' };
const BOB = { id: 'user-bob', username: 'bob' };
type Operator = typeof ALICE;

/** A member-join DM: ready when it has something to say, incomplete when it has not. */
function greeter(message: string): FlowGraph {
    return {
        version: FLOW_GRAPH_VERSION,
        nodes: [
            { id: 'join', type: 'trigger.memberJoin', position: { x: 0, y: 0 }, data: {} },
            { id: 'dm', type: 'action.sendDM', position: { x: 0, y: 160 }, data: { message } },
        ],
        edges: [{ id: 'join-dm', source: 'join', target: 'dm' }],
    };
}
const READY = greeter('Welcome, you absolute menace.');
const INCOMPLETE = greeter('');

/** A message sent to the channel a journey declares — installed once `channelId` is filled. */
function postingTo(channelId: string): FlowGraph {
    return {
        version: FLOW_GRAPH_VERSION,
        nodes: [
            {
                id: 'post',
                type: 'action.sendMessage',
                position: { x: 0, y: 0 },
                data: { channelId, channelIdKey: 'qa-channel', message: 'Ask away.' },
            },
        ],
        edges: [],
    };
}

interface Reply<T> {
    readonly status: number;
    readonly body: T;
}

interface FlowBody {
    flowId: string;
    name: string;
    enabled: boolean;
    graph: FlowGraph;
    issues: { nodeId?: string }[];
    updatedAt: string;
}

interface DraftBody {
    draftId: number;
    authorId: string;
    authorName: string;
    mine: boolean;
    name: string;
    graph: FlowGraph;
    issues: { nodeId?: string }[];
    flowSavedSince: boolean;
}

function app(operator: Operator): Hono<AppEnv> {
    const outer = new Hono<AppEnv>();
    outer.use('*', async (c, next) => {
        c.set('guild', { id: GUILD_ID } as never);
        c.set('user', { ...operator, avatar: null, manageableGuildIds: [GUILD_ID] });
        await next();
    });
    outer.route('/', flowRoutes());
    // As the dashboard's own handler answers: a generic 500 carrying none of the
    // route's words — which is exactly what a driver error must look like.
    outer.onError((_error, c) => c.json({ error: 'Internal error.' }, 500));
    return outer;
}

async function send<T>(operator: Operator, method: string, path: string, body?: unknown): Promise<Reply<T>> {
    const response = await app(operator).request(`/${GUILD_ID}${path}`, {
        method,
        headers: body === undefined ? undefined : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    return { status: response.status, body: (text ? JSON.parse(text) : undefined) as T };
}

/** A flow holding `graph`, switched on when asked — through the routes, as the builder would. */
async function flowWith(graph: FlowGraph, options: { enabled?: boolean } = {}): Promise<FlowBody> {
    const created = await send<FlowBody>(ALICE, 'POST', '/flows', { name: 'Greeter', graph });
    expect(created.status).toBe(201);
    if (!options.enabled) return created.body;

    const enabled = await send<FlowBody>(ALICE, 'PUT', `/flows/${created.body.flowId}`, { enabled: true });
    expect(enabled.status).toBe(200);
    return enabled.body;
}

async function draftsOf(flowId: string, viewer: Operator = ALICE): Promise<DraftBody[]> {
    const listed = await send<{ drafts: DraftBody[] }>(viewer, 'GET', `/flows/${flowId}/drafts`);
    expect(listed.status).toBe(200);
    return listed.body.drafts;
}

/**
 * Write `operator`'s draft of `flow`, as the builder's autosave does — naming the flow
 * version the canvas was loaded from, which is `flow` itself unless told otherwise.
 */
async function saveDraft(
    operator: Operator,
    flow: FlowBody,
    content: { name?: string; graph: FlowGraph },
    loadedAt: string = flow.updatedAt
): Promise<Reply<DraftBody>> {
    return send<DraftBody>(operator, 'PUT', `/flows/${flow.flowId}/drafts/mine`, {
        name: content.name ?? 'Greeter',
        graph: content.graph,
        baseUpdatedAt: loadedAt,
    });
}

/** Declare `qa-channel` on a journey the flow is attached to. */
async function declareQaChannel(flow: FlowBody): Promise<void> {
    const journeyKey = `qa-${flow.flowId}`;
    await journeysRepo.create({
        guildId: GUILD_ID,
        journeyKey,
        name: 'Questions',
        resources: [{ key: 'qa-channel', kind: 'textChannel', defaultName: 'questions' }],
    });
    await flowJourneyLinksRepo.attach({ guildId: GUILD_ID, flowId: flow.flowId, journeyKey });
}

/** Timestamps are millisecond-resolution; this keeps "saved since" from being a coin toss. */
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5));

beforeAll(async () => {
    await migrateTestDatabase();
    await ensureBlocksDiscovered();
});

afterEach(() => {
    vi.restoreAllMocks();
});

describe('saving an incomplete graph onto a live flow', () => {
    it('keeps it as the saver’s draft and leaves the live flow exactly as it was', async () => {
        const live = await flowWith(READY, { enabled: true });

        const saved = await send<FlowBody & { savedAs: string; draft: DraftBody }>(ALICE, 'PUT', `/flows/${live.flowId}`, {
            name: 'Greeter, but worse',
            graph: INCOMPLETE,
        });

        expect(saved.status).toBe(200);
        expect(saved.body.savedAs).toBe('draft');
        expect(saved.body.draft).toMatchObject({ mine: true, name: 'Greeter, but worse', graph: INCOMPLETE });
        expect(saved.body.draft.issues.map((issue) => issue.nodeId)).toEqual(['dm']);

        // Read back rather than trusted from the response: the row itself is untouched —
        // its graph, its name, and its timestamp, which would have moved on any write.
        const stored = await send<FlowBody>(BOB, 'GET', `/flows/${live.flowId}`);
        expect(stored.body).toMatchObject({ name: 'Greeter', enabled: true, graph: READY, issues: [] });
        expect(stored.body.updatedAt).toBe(live.updatedAt);

        const [draft] = await draftsOf(live.flowId);
        expect(draft).toMatchObject({ authorId: ALICE.id, graph: INCOMPLETE, flowSavedSince: false });
    });

    it('bases the draft on the version the saver loaded, not the one it lands beside', async () => {
        const live = await flowWith(READY, { enabled: true });
        await tick();
        // Somebody renames the flow after Alice opened it and before she saves.
        await send(BOB, 'PUT', `/flows/${live.flowId}`, { name: 'Greeter, renamed' });

        await send(ALICE, 'PUT', `/flows/${live.flowId}`, { graph: INCOMPLETE, baseUpdatedAt: live.updatedAt });

        const [draft] = await draftsOf(live.flowId);
        expect(draft).toMatchObject({ authorId: ALICE.id, flowSavedSince: true });
    });

    it('keeps a complete graph that is waiting on its install off the live flow too', async () => {
        const live = await flowWith(postingTo(''));
        await declareQaChannel(live);
        // Installed and switched on, as install would leave it: the id written in.
        await send(ALICE, 'PUT', `/flows/${live.flowId}`, { graph: postingTo('111111111111111111') });
        expect((await send(ALICE, 'PUT', `/flows/${live.flowId}`, { enabled: true })).status).toBe(200);

        // A canvas from before the install — nothing wrong with it, but the id is gone.
        const saved = await send<{ savedAs: string; issues: unknown[]; uninstalled: string[]; draft: DraftBody }>(
            ALICE,
            'PUT',
            `/flows/${live.flowId}`,
            { graph: postingTo('') }
        );

        expect(saved.body).toMatchObject({ savedAs: 'draft', issues: [], uninstalled: ['qa-channel'] });
        expect(saved.body.draft.issues).toEqual([]);
        const stored = await send<FlowBody>(ALICE, 'GET', `/flows/${live.flowId}`);
        expect(stored.body.graph).toEqual(postingTo('111111111111111111'));
    });

    it('stores it on the flow when the same request switches the flow off', async () => {
        const live = await flowWith(READY, { enabled: true });

        const saved = await send<FlowBody & { savedAs: string }>(ALICE, 'PUT', `/flows/${live.flowId}`, {
            graph: INCOMPLETE,
            enabled: false,
        });

        expect(saved.body).toMatchObject({ savedAs: 'flow', enabled: false, graph: INCOMPLETE });
        expect(await draftsOf(live.flowId)).toEqual([]);
    });
});

describe('a save that lands on the flow', () => {
    it('discards the saver’s own draft and nobody else’s', async () => {
        const flow = await flowWith(READY);
        await saveDraft(ALICE, flow, { name: 'Alice’s idea', graph: INCOMPLETE });
        await saveDraft(BOB, flow, { name: 'Bob’s idea', graph: INCOMPLETE });

        const saved = await send<{ savedAs: string }>(ALICE, 'PUT', `/flows/${flow.flowId}`, { graph: INCOMPLETE });

        expect(saved.body.savedAs).toBe('flow');
        expect((await draftsOf(flow.flowId)).map((draft) => draft.authorName)).toEqual(['bob']);
    });

    it('leaves the saver’s draft alone when the save carries no graph', async () => {
        // The list's switch and a rename are not the author's canvas landing; a draft
        // they are still working on must survive them.
        const flow = await flowWith(READY);
        await saveDraft(ALICE, flow, { graph: INCOMPLETE });

        await send(ALICE, 'PUT', `/flows/${flow.flowId}`, { enabled: true });
        await send(ALICE, 'PUT', `/flows/${flow.flowId}`, { name: 'Renamed' });

        expect(await draftsOf(flow.flowId)).toHaveLength(1);
    });
});

describe('listing drafts', () => {
    it('tells each operator which draft is theirs, and which the flow was saved after', async () => {
        // Alice opens the flow; then Carol saves it; then Bob opens it.
        const openedByAlice = await flowWith(READY);
        await tick();
        const saved = await send<FlowBody>({ id: 'user-carol', username: 'carol' }, 'PUT', `/flows/${openedByAlice.flowId}`, {
            name: 'Greeter 2',
        });
        const openedByBob = saved.body;
        await tick();

        // Both autosave only now — Alice's first write lands *after* Carol's save, which
        // is the case a base read off the flow at write time would get wrong.
        await saveDraft(ALICE, openedByAlice, { graph: INCOMPLETE });
        await saveDraft(BOB, openedByBob, { graph: READY });
        await tick();
        await saveDraft(ALICE, openedByAlice, { graph: READY });

        const asAlice = await draftsOf(openedByAlice.flowId, ALICE);
        const asBob = await draftsOf(openedByAlice.flowId, BOB);

        const byAuthor = (drafts: DraftBody[], author: Operator) => drafts.find((draft) => draft.authorId === author.id);
        expect(byAuthor(asAlice, ALICE)).toMatchObject({ mine: true, flowSavedSince: true });
        expect(byAuthor(asAlice, BOB)).toMatchObject({ mine: false, flowSavedSince: false, authorName: 'bob' });
        expect(byAuthor(asBob, ALICE)).toMatchObject({ mine: false });
        expect(byAuthor(asBob, BOB)).toMatchObject({ mine: true });
        // Most recently edited first.
        expect(asAlice.map((draft) => draft.authorId)).toEqual([ALICE.id, BOB.id]);
    });

    it('is a 404 for a flow in another guild, and refuses a structurally broken draft', async () => {
        const flow = await flowWith(READY);
        await database.updateTable('flows').set({ guildId: 'someone-else' }).where('flowId', '=', flow.flowId).execute();

        expect((await send(ALICE, 'GET', `/flows/${flow.flowId}/drafts`)).status).toBe(404);
        expect((await saveDraft(ALICE, flow, { graph: READY })).status).toBe(404);

        const mine = await flowWith(READY);
        const broken = await saveDraft(ALICE, mine, {
            graph: { ...READY, edges: [{ id: 'e', source: 'nowhere', target: 'nothing' }] },
        });
        expect(broken.status).toBe(400);
        expect(await draftsOf(mine.flowId)).toEqual([]);
    });
});

describe('discarding a draft', () => {
    it('reaches only drafts of the flow in the URL, whoever wrote them', async () => {
        const first = await flowWith(READY);
        const second = await flowWith(READY);
        await saveDraft(BOB, second, { graph: INCOMPLETE });
        const [bobs] = await draftsOf(second.flowId);

        // Bob's draft id, under the wrong flow: not found, and still there.
        const crossed = await send(ALICE, 'DELETE', `/flows/${first.flowId}/drafts/${bobs!.draftId}`);
        expect(crossed.status).toBe(404);
        expect(await draftsOf(second.flowId)).toHaveLength(1);

        // Under its own flow, anyone may discard it.
        const discarded = await send(ALICE, 'DELETE', `/flows/${second.flowId}/drafts/${bobs!.draftId}`);
        expect(discarded.status).toBe(204);
        expect(await draftsOf(second.flowId)).toEqual([]);
    });

    it('goes with the flow when the flow is deleted', async () => {
        const flow = await flowWith(READY);
        await saveDraft(ALICE, flow, { graph: INCOMPLETE });

        expect((await send(ALICE, 'DELETE', `/flows/${flow.flowId}`)).status).toBe(204);

        const left = await database.selectFrom('flow_drafts').select('id').where('flowId', '=', flow.flowId).execute();
        expect(left).toEqual([]);
    });
});

describe('switching on a flow that is waiting on its install', () => {
    it('is refused with its own sentence, and the wait is not counted as a problem', async () => {
        const flow = await flowWith(postingTo(''));
        await declareQaChannel(flow);

        const refused = await send<{ error: string; issues: unknown[] }>(ALICE, 'PUT', `/flows/${flow.flowId}`, {
            enabled: true,
        });

        expect(refused.status).toBe(400);
        expect(refused.body.error).toBe(
            'Install this flow\'s resources before turning it on — "qa-channel" isn\'t in the server yet.'
        );
        // Ready, just not installed: no problem on the canvas, and none on the list's chip.
        const stored = await send<FlowBody>(ALICE, 'GET', `/flows/${flow.flowId}`);
        expect(stored.body).toMatchObject({ enabled: false, issues: [] });
        const listed = await send<{ flows: { flowId: string; issueCount: number }[] }>(ALICE, 'GET', '/flows');
        expect(listed.body.flows.find((row) => row.flowId === flow.flowId)?.issueCount).toBe(0);

        // Once install has written the id — the sidecar stays, as install leaves it — it goes.
        await send(ALICE, 'PUT', `/flows/${flow.flowId}`, { graph: postingTo('111111111111111111') });
        const enabled = await send<FlowBody>(ALICE, 'PUT', `/flows/${flow.flowId}`, { enabled: true });
        expect(enabled.status).toBe(200);
        expect(enabled.body.enabled).toBe(true);
    });
});

describe('reading a flow’s declarations', () => {
    it('names a malformed journey row as one', async () => {
        const flow = await flowWith(READY);
        const journeyKey = `broken-${flow.flowId}`;
        await journeysRepo.create({ guildId: GUILD_ID, journeyKey, name: 'Broken', resources: [] });
        await flowJourneyLinksRepo.attach({ guildId: GUILD_ID, flowId: flow.flowId, journeyKey });
        await sql`update journeys set resources = '{"not":"a list"}' where journey_key = ${journeyKey}`.execute(database);

        const read = await send<{ error: string }>(ALICE, 'GET', `/flows/${flow.flowId}`);

        expect(read.status).toBe(500);
        expect(read.body.error).toMatch(/stored in a state the server can't read/);
        expect(read.body.error).toMatch(/not an array/);
    });

    it('does not dress a driver error up as a malformed journey', async () => {
        const flow = await flowWith(READY);
        vi.spyOn(flowJourneyLinksRepo, 'getJourneyKeyForFlow').mockRejectedValue(
            new Error('SQLITE_BUSY: database is locked')
        );

        const read = await send<{ error: string }>(ALICE, 'GET', `/flows/${flow.flowId}`);

        // The ordinary 500 — not a sentence sending the operator to inspect a row that
        // is fine.
        expect(read.status).toBe(500);
        expect(read.body.error).toBe('Internal error.');
    });
});
