import { Hono } from 'hono';
import { beforeAll, describe, expect, it } from 'vitest';
import { ACTION_POST_EMBED } from '../../../features/flows/blocks/actionPostEmbed';
import { ensureBlocksDiscovered } from '../../../features/flows/blocks/registry';
import { TRIGGER_BUTTON_CLICK } from '../../../features/flows/blocks/triggerButtonClick';
import { FLOW_GRAPH_VERSION, type FlowGraph, type FlowNode } from '../../../features/flows/data/flowGraph';
import { flowsRepo } from '../../../features/flows/data/flowsRepo';
import { flowDeclarations } from '../../../features/flows/logic/flowDeclarations';
import { flowJourneyLinksRepo } from '../../../features/provisioning/data/flowJourneyLinksRepo';
import { journeysRepo } from '../../../features/provisioning/data/journeysRepo';
import type { ResourceDeclaration } from '../../../features/provisioning/logic/resourceDeclaration';
import { migrateTestDatabase } from '../../../features-system/data-persistence/__tests__/support/migrateTestDatabase';
import type { AppEnv } from '../../types';
import { flowRoutes } from '../flowRoutes';
import { journeyRoutes } from '../journeyRoutes';

/**
 * One flow per button, through the real routes, repos and an in-memory SQLite built by the
 * real migrations: a flow may not go live on a button another live flow of its journey
 * already listens to — not by switching on, not by a live save, not by being moved into the
 * journey — and the listener route lists who listens.
 *
 * Real rather than mocked because the check reads every flow and link in the guild, and the
 * assertions are about what the database ends up holding. Every case runs in a guild of its
 * own.
 */

const OPERATOR = { id: 'user-alice', username: 'alice', avatar: null };

interface Reply<T> {
    readonly status: number;
    readonly body: T;
}

interface RefusalBody {
    error: string;
    issues?: unknown[];
}

const JOURNEY_KEY = 'rules-journey';

/** A channel and a rules panel in it with two buttons. */
const DECLARATIONS: ResourceDeclaration[] = [
    { key: 'rules', kind: 'textChannel', defaultName: 'rules' },
    {
        key: 'rules-panel',
        kind: 'message',
        defaultName: 'Rules panel',
        parentKey: 'rules',
        message: { embeds: [{ title: 'House Rules' }] },
        buttons: [
            { key: 'verify', label: 'Verify', style: 'Success' },
            { key: 'nope', label: 'Nope', style: 'Danger' },
        ],
    },
];

/** A Button Click on one of the panel's buttons, and nothing after it. */
function pressing(buttonKey: string): FlowGraph {
    return {
        version: FLOW_GRAPH_VERSION,
        nodes: [
            {
                id: `press-${buttonKey}`,
                type: TRIGGER_BUTTON_CLICK,
                position: { x: 0, y: 0 },
                data: { button: { messageKey: 'rules-panel', buttonKey }, eligibility: { principal: 'anyone' } },
            },
        ],
        edges: [],
    };
}

const POST_CHANNEL_ID = '111111111111111111';

/** A Post Embed posting `Kneel, pet` with one `kneel` button, as node `post`. */
const POST_NODE: FlowNode = {
    id: 'post',
    type: ACTION_POST_EMBED,
    position: { x: 0, y: 0 },
    data: {
        channelId: POST_CHANNEL_ID,
        message: { embeds: [{ title: 'Kneel, pet' }] },
        buttons: [{ key: 'kneel', label: 'Kneel', style: 'Primary' }],
    },
};

const POSTER_GRAPH: FlowGraph = { version: FLOW_GRAPH_VERSION, nodes: [POST_NODE], edges: [] };

/** A Button Click on `flowId`'s `post` node's `kneel` button, with `extra` nodes beside it. */
function pressingBlock(flowId: string, extra: FlowNode[] = []): FlowGraph {
    return {
        version: FLOW_GRAPH_VERSION,
        nodes: [
            {
                id: 'press-kneel',
                type: TRIGGER_BUTTON_CLICK,
                position: { x: 0, y: 200 },
                data: { button: { flowId, nodeId: 'post', buttonKey: 'kneel' }, eligibility: { principal: 'anyone' } },
            },
            ...extra,
        ],
        edges: [],
    };
}

let guildCount = 0;

/** A guild no other case has touched, holding the rules journey. */
async function freshGuild(): Promise<string> {
    guildCount += 1;
    const guildId = `claims-guild-${guildCount}`;
    await journeysRepo.create({ guildId, journeyKey: JOURNEY_KEY, name: 'Rules', resources: DECLARATIONS });
    return guildId;
}

/** A flow stored straight through the repo, on or off, linked to `journeyKey` when one is given. */
async function stored(
    guildId: string,
    name: string,
    graph: FlowGraph,
    enabled: boolean,
    journeyKey: string | null = JOURNEY_KEY
): Promise<string> {
    const flow = await flowsRepo.create({ guildId, name, graph, enabled });
    if (journeyKey) {
        await flowJourneyLinksRepo.attach({ guildId, flowId: flow.flowId, journeyKey });
    }
    return flow.flowId;
}

async function reread(flowId: string) {
    const flow = await flowsRepo.getByFlowId(flowId);
    if (!flow) throw new Error(`flow ${flowId} vanished`);
    return flow;
}

function app(guildId: string): Hono<AppEnv> {
    const outer = new Hono<AppEnv>();
    outer.use('*', async (c, next) => {
        // Holding the one channel a Post Embed here posts in, which readiness looks up.
        c.set('guild', { id: guildId, channels: { cache: new Map([[POST_CHANNEL_ID, { id: POST_CHANNEL_ID }]]) } } as never);
        c.set('user', { ...OPERATOR, manageableGuildIds: [guildId] });
        await next();
    });
    outer.route('/', flowRoutes());
    outer.route('/', journeyRoutes());
    outer.onError((_error, c) => c.json({ error: 'Internal error.' }, 500));
    return outer;
}

async function send<T>(guildId: string, method: string, path: string, body?: unknown): Promise<Reply<T>> {
    const response = await app(guildId).request(`/${guildId}${path}`, {
        method,
        headers: { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: (await response.json()) as T };
}

// Every migration and the block scan: past the default hook timeout under a full parallel run.
beforeAll(async () => {
    await migrateTestDatabase();
    await ensureBlocksDiscovered();
}, 30_000);

const WELCOME_HOLDS_VERIFY =
    '"Welcome" already listens to "Verify" on "Rules panel". One flow per button — point this trigger at another.';

describe('going live on a button another flow listens to', () => {
    it('refuses a live flow’s graph saved onto a taken button, naming the other flow, and keeps its graph', async () => {
        const guildId = await freshGuild();
        await stored(guildId, 'Welcome', pressing('verify'), true);
        const gatekeeperId = await stored(guildId, 'Gatekeeper', pressing('nope'), true);

        const refused = await send<RefusalBody>(guildId, 'PUT', `/flows/${gatekeeperId}`, {
            graph: pressing('verify'),
        });

        expect(refused.status).toBe(400);
        expect(refused.body).toEqual({ error: WELCOME_HOLDS_VERIFY, issues: [] });
        expect((await reread(gatekeeperId)).graph).toEqual(pressing('nope'));
    });

    it('stores an off flow’s graph on a taken button, then refuses switching it on', async () => {
        const guildId = await freshGuild();
        await stored(guildId, 'Welcome', pressing('verify'), true);
        const gatekeeperId = await stored(guildId, 'Gatekeeper', pressing('nope'), false);

        const saved = await send<{ savedAs: string }>(guildId, 'PUT', `/flows/${gatekeeperId}`, {
            graph: pressing('verify'),
        });
        expect(saved.status).toBe(200);
        expect(saved.body.savedAs).toBe('flow');
        expect((await reread(gatekeeperId)).graph).toEqual(pressing('verify'));

        const switched = await send<RefusalBody>(guildId, 'PUT', `/flows/${gatekeeperId}`, { enabled: true });

        expect(switched.status).toBe(400);
        expect(switched.body).toEqual({ error: WELCOME_HOLDS_VERIFY, issues: [] });
        expect((await reread(gatekeeperId)).enabled).toBe(false);
    });

    it('lets a flow in another journey go live on the same keys', async () => {
        const guildId = await freshGuild();
        await stored(guildId, 'Welcome', pressing('verify'), true);
        await journeysRepo.create({ guildId, journeyKey: 'other-rules', name: 'Other rules', resources: DECLARATIONS });
        const elsewhereId = await stored(guildId, 'Elsewhere', pressing('verify'), false, 'other-rules');

        const switched = await send<{ enabled: boolean }>(guildId, 'PUT', `/flows/${elsewhereId}`, { enabled: true });

        expect(switched.status).toBe(200);
        expect(switched.body.enabled).toBe(true);
    });

    it('lets a flow go live beside an off flow on the same button', async () => {
        const guildId = await freshGuild();
        await stored(guildId, 'Welcome', pressing('verify'), false);
        const gatekeeperId = await stored(guildId, 'Gatekeeper', pressing('verify'), false);

        const switched = await send<{ enabled: boolean }>(guildId, 'PUT', `/flows/${gatekeeperId}`, { enabled: true });

        expect(switched.status).toBe(200);
        expect(switched.body.enabled).toBe(true);
    });

    it("refuses switching on a flow on a block's button another live flow of the journey holds, naming the post", async () => {
        const guildId = await freshGuild();
        const posterId = await stored(guildId, 'Poster', POSTER_GRAPH, false);
        await stored(guildId, 'Welcome', pressingBlock(posterId), true);
        const gatekeeperId = await stored(guildId, 'Gatekeeper', pressingBlock(posterId), false);

        const switched = await send<RefusalBody>(guildId, 'PUT', `/flows/${gatekeeperId}`, { enabled: true });

        expect(switched.status).toBe(400);
        expect(switched.body).toEqual({
            error: '"Welcome" already listens to "Kneel" on "Kneel, pet in Poster". One flow per button — point this trigger at another.',
            issues: [],
        });
        expect((await reread(gatekeeperId)).enabled).toBe(false);
    });

    it("refuses switching on a flow on a block's button of a flow outside its journey, at the field", async () => {
        const guildId = await freshGuild();
        const strangerId = await stored(guildId, 'Stranger', POSTER_GRAPH, false, null);
        const listenerId = await stored(guildId, 'Listener', pressingBlock(strangerId), false);

        const switched = await send<RefusalBody>(guildId, 'PUT', `/flows/${listenerId}`, { enabled: true });

        expect(switched.status).toBe(400);
        expect(switched.body.issues).toEqual([
            {
                nodeId: 'press-kneel',
                field: 'button',
                message: "That button's flow isn't in this flow's journey any more, or it's gone. Pick another.",
            },
        ]);
    });

    it('saves a live flow listening to a post only the graph being saved holds', async () => {
        const guildId = await freshGuild();
        const flowId = await stored(guildId, 'Talks to itself', pressing('nope'), true);

        const saved = await send<{ savedAs: string }>(guildId, 'PUT', `/flows/${flowId}`, {
            graph: pressingBlock(flowId, [POST_NODE]),
        });

        expect(saved.status).toBe(200);
        expect(saved.body.savedAs).toBe('flow');
    });
});

describe('the flows list', () => {
    /** Each row's `issueCount`, by flow id. */
    async function issueCounts(guildId: string): Promise<Map<string, number>> {
        const listed = await send<{ flows: { flowId: string; issueCount: number }[] }>(guildId, 'GET', '/flows');
        expect(listed.status).toBe(200);
        return new Map(listed.body.flows.map((row) => [row.flowId, row.issueCount] as const));
    }

    it("judges a pick on another flow's post as the builder does: clean while the poster is in the journey, one issue once it leaves", async () => {
        const guildId = await freshGuild();
        const posterId = await stored(guildId, 'Poster', POSTER_GRAPH, false);
        const listenerId = await stored(guildId, 'Listener', pressingBlock(posterId), false);

        expect((await issueCounts(guildId)).get(listenerId)).toBe(0);

        await journeysRepo.create({ guildId, journeyKey: 'elsewhere', name: 'Elsewhere', resources: [] });
        await flowJourneyLinksRepo.attach({ guildId, flowId: posterId, journeyKey: 'elsewhere' });

        expect((await issueCounts(guildId)).get(listenerId)).toBe(1);
    });
});

describe('flowDeclarations', () => {
    it("lists the journey's other flows, never the flow itself", async () => {
        const guildId = await freshGuild();
        const posterId = await stored(guildId, 'Poster', POSTER_GRAPH, false);
        const listenerId = await stored(guildId, 'Listener', pressingBlock(posterId), true);

        const declared = await flowDeclarations(guildId, listenerId);

        expect(declared.journeyFlows).toEqual([{ flowId: posterId, name: 'Poster', graph: POSTER_GRAPH }]);
    });
});

describe('moving a live flow onto a taken button', () => {
    const MOVE_REFUSAL =
        '"Welcome" already listens to "Verify" on "Rules panel". "Gatekeeper" listens to it too, and one press ' +
        'starts one flow. Switch one of them off or point it at another button, then try again.';

    it('warns in the group preview, then refuses the grouping and leaves the flow where it was', async () => {
        const guildId = await freshGuild();
        const welcomeId = await stored(guildId, 'Welcome', pressing('verify'), true);
        const gatekeeperId = await stored(guildId, 'Gatekeeper', pressing('verify'), true, null);

        const preview = await send<{ buttonConflict: string | null }>(
            guildId,
            'GET',
            `/flows/${gatekeeperId}/group-preview?target=${welcomeId}`
        );
        expect(preview.status).toBe(200);
        expect(preview.body.buttonConflict).toBe(MOVE_REFUSAL);

        const grouped = await send<RefusalBody>(guildId, 'POST', `/flows/${gatekeeperId}/group`, {
            targetFlowId: welcomeId,
        });

        expect(grouped.status).toBe(409);
        expect(grouped.body.error).toBe(MOVE_REFUSAL);
        expect(await flowJourneyLinksRepo.getJourneyKeyForFlow(guildId, gatekeeperId)).toBeNull();
    });

    it('refuses attaching it to the journey', async () => {
        const guildId = await freshGuild();
        await stored(guildId, 'Welcome', pressing('verify'), true);
        const gatekeeperId = await stored(guildId, 'Gatekeeper', pressing('verify'), true, null);

        const attached = await send<RefusalBody>(guildId, 'POST', `/flows/${gatekeeperId}/attach`, {
            journeyKey: JOURNEY_KEY,
        });

        expect(attached.status).toBe(409);
        expect(attached.body.error).toBe(MOVE_REFUSAL);
        expect(await flowJourneyLinksRepo.getJourneyKeyForFlow(guildId, gatekeeperId)).toBeNull();
    });

    /**
     * A flow with its link gone falls back to the journey keyed by its own id. Detaching a live
     * flow is therefore a move into that journey whenever it exists, and a live flow there on
     * the same button would leave every press answering "neither runs".
     */
    it('refuses detaching it back onto the journey keyed by its id, where a live flow holds its button', async () => {
        const guildId = await freshGuild();
        const legacyId = await stored(guildId, 'Gatekeeper', pressing('verify'), true);
        await journeysRepo.create({ guildId, journeyKey: legacyId, name: 'Gatekeeper', resources: DECLARATIONS });
        await stored(guildId, 'Welcome', pressing('verify'), true, legacyId);

        const detached = await send<RefusalBody>(guildId, 'POST', `/flows/${legacyId}/detach`);

        expect(detached.status).toBe(409);
        expect(detached.body.error).toBe(MOVE_REFUSAL);
        expect(await flowJourneyLinksRepo.getJourneyKeyForFlow(guildId, legacyId)).toBe(JOURNEY_KEY);
    });

    it('detaches it when the journey keyed by its id has nobody on its button', async () => {
        const guildId = await freshGuild();
        const legacyId = await stored(guildId, 'Gatekeeper', pressing('verify'), true);
        await journeysRepo.create({ guildId, journeyKey: legacyId, name: 'Gatekeeper', resources: DECLARATIONS });
        await stored(guildId, 'Welcome', pressing('nope'), true, legacyId);

        const detached = await send<{ detached: boolean }>(guildId, 'POST', `/flows/${legacyId}/detach`);

        expect(detached.status).toBe(200);
        expect(detached.body.detached).toBe(true);
        expect(await flowJourneyLinksRepo.getJourneyKeyForFlow(guildId, legacyId)).toBeNull();
    });

    it('groups an off flow on the same button, with no warning — switching it on is what is refused', async () => {
        const guildId = await freshGuild();
        const welcomeId = await stored(guildId, 'Welcome', pressing('verify'), true);
        const gatekeeperId = await stored(guildId, 'Gatekeeper', pressing('verify'), false, null);

        const preview = await send<{ buttonConflict: string | null }>(
            guildId,
            'GET',
            `/flows/${gatekeeperId}/group-preview?target=${welcomeId}`
        );
        expect(preview.body.buttonConflict).toBeNull();

        const grouped = await send<{ journeyKey: string }>(guildId, 'POST', `/flows/${gatekeeperId}/group`, {
            targetFlowId: welcomeId,
        });

        expect(grouped.status).toBe(200);
        expect(await flowJourneyLinksRepo.getJourneyKeyForFlow(guildId, gatekeeperId)).toBe(JOURNEY_KEY);
    });
});

describe('GET /journeys/{journeyKey}/button-listeners', () => {
    it('lists every trigger of the journey’s flows, live and off, and none of another journey’s', async () => {
        const guildId = await freshGuild();
        const welcomeId = await stored(guildId, 'Welcome', pressing('verify'), true);
        const doormanId = await stored(guildId, 'Doorman', pressing('nope'), false);
        await journeysRepo.create({ guildId, journeyKey: 'other-rules', name: 'Other rules', resources: DECLARATIONS });
        await stored(guildId, 'Elsewhere', pressing('verify'), true, 'other-rules');

        const listed = await send<{ listeners: unknown[] }>(
            guildId,
            'GET',
            `/journeys/${JOURNEY_KEY}/button-listeners`
        );

        expect(listed.status).toBe(200);
        expect(listed.body.listeners).toEqual([
            {
                messageKey: 'rules-panel',
                buttonKey: 'verify',
                flowId: welcomeId,
                flowName: 'Welcome',
                nodeId: 'press-verify',
                enabled: true,
            },
            {
                messageKey: 'rules-panel',
                buttonKey: 'nope',
                flowId: doormanId,
                flowName: 'Doorman',
                nodeId: 'press-nope',
                enabled: false,
            },
        ]);
    });

    /** The one membership rule: a flow is in the journey only when `resolveFlowJourney` says so. */
    it('leaves out a flow grouped away from the journey keyed on its id', async () => {
        const guildId = await freshGuild();
        const legacyId = await stored(guildId, 'Legacy', pressing('verify'), true, null);
        await journeysRepo.create({ guildId, journeyKey: legacyId, name: 'Legacy', resources: DECLARATIONS });

        // On the pre-link fallback it is in its own journey...
        const before = await send<{ listeners: unknown[] }>(guildId, 'GET', `/journeys/${legacyId}/button-listeners`);
        expect(before.body.listeners).toHaveLength(1);

        // ...and grouped away, it is not, though the journey keyed on its id is still there.
        await flowJourneyLinksRepo.attach({ guildId, flowId: legacyId, journeyKey: JOURNEY_KEY });
        const after = await send<{ listeners: unknown[] }>(guildId, 'GET', `/journeys/${legacyId}/button-listeners`);

        expect(after.status).toBe(200);
        expect(after.body.listeners).toEqual([]);
    });

    it('answers 404 for another guild’s journey, never confirming it', async () => {
        const guildId = await freshGuild();
        const otherGuildId = await freshGuild();
        await journeysRepo.create({
            guildId: otherGuildId,
            journeyKey: 'theirs',
            name: 'Theirs',
            resources: DECLARATIONS,
        });

        const listed = await send<RefusalBody>(guildId, 'GET', '/journeys/theirs/button-listeners');

        expect(listed.status).toBe(404);
        expect(listed.body.error).toBe('Journey not found.');
    });

    it("lists the journey's posting nodes and every trigger naming a block's button, and none of another journey's", async () => {
        const guildId = await freshGuild();
        const posterId = await stored(guildId, 'Poster', POSTER_GRAPH, false);
        const listenerId = await stored(guildId, 'Listener', pressingBlock(posterId), true);
        await journeysRepo.create({ guildId, journeyKey: 'other-rules', name: 'Other rules', resources: DECLARATIONS });
        await stored(guildId, 'Elsewhere', pressingBlock(posterId, [POST_NODE]), true, 'other-rules');

        const listed = await send<{ listeners: unknown[]; blockMessages: unknown[]; blockListeners: unknown[] }>(
            guildId,
            'GET',
            `/journeys/${JOURNEY_KEY}/button-listeners`
        );

        expect(listed.status).toBe(200);
        expect(listed.body.listeners).toEqual([]);
        expect(listed.body.blockMessages).toEqual([
            {
                flowId: posterId,
                flowName: 'Poster',
                nodeId: 'post',
                blockLabel: 'Post Embed',
                headline: 'Kneel, pet',
                buttons: [{ key: 'kneel', label: 'Kneel', style: 'Primary' }],
            },
        ]);
        expect(listed.body.blockListeners).toEqual([
            {
                messageFlowId: posterId,
                messageNodeId: 'post',
                buttonKey: 'kneel',
                flowId: listenerId,
                flowName: 'Listener',
                nodeId: 'press-kneel',
                enabled: true,
            },
        ]);
    });
});
