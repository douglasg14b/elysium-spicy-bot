import { Hono } from 'hono';
import { beforeAll, describe, expect, it } from 'vitest';
import { ensureBlocksDiscovered } from '../../../features/flows/blocks/registry';
import { FLOW_GRAPH_VERSION, type FlowGraph } from '../../../features/flows/data/flowGraph';
import { flowsRepo } from '../../../features/flows/data/flowsRepo';
import { migrateTestDatabase } from '../../../features-system/data-persistence/__tests__/support/migrateTestDatabase';
import type { AppEnv } from '../../types';
import { flowRoutes } from '../flowRoutes';

/**
 * Loop refusal through the real PUT route, repos and an in-memory sqlite built by the
 * real migrations: a flow may not go live into a loop with the guild's other live flows.
 *
 * Real rather than mocked because the check reads every flow in the guild and the
 * assertions are about what the database ends up holding — the row left off, the graph
 * left as it was. Every case runs in a guild of its own, since the check reads the whole
 * guild and a case deliberately leaves live flows behind.
 *
 * A loop already live can't be built through the route (that is the feature), so the
 * cases that need one write the rows straight through the repo, as a guild from before
 * this check would hold them.
 */

const OPERATOR = { id: 'user-alice', username: 'alice', avatar: null };

interface Reply<T> {
    readonly status: number;
    readonly body: T;
}

interface FlowBody {
    flowId: string;
    name: string;
    enabled: boolean;
    graph: FlowGraph;
    savedAs?: 'flow' | 'draft';
}

interface RefusalBody {
    error: string;
    issues: unknown[];
}

function graphOf(nodes: FlowGraph['nodes'], edges: FlowGraph['edges'] = []): FlowGraph {
    return { version: FLOW_GRAPH_VERSION, nodes, edges };
}

/** Member Leaves → Kick Member: a flow that starts itself, every run, needing no ticketing. */
const SELF_LOOP = graphOf(
    [
        { id: 'leaves', type: 'trigger.memberLeave', position: { x: 0, y: 0 }, data: {} },
        { id: 'kick', type: 'action.kickMember', position: { x: 0, y: 160 }, data: {} },
    ],
    [{ id: 'leaves-kick', source: 'leaves', target: 'kick' }]
);

/** Member Leaves on its own: ready, and causes nothing. */
const LONE_LEAVE = graphOf([{ id: 'leaves', type: 'trigger.memberLeave', position: { x: 0, y: 0 }, data: {} }]);

/** Ticket Closed → Open Ticket (Support): one half of a two-flow loop. */
const REOPENER = graphOf(
    [
        { id: 'closed', type: 'trigger.ticketEvent', position: { x: 0, y: 0 }, data: { event: 'closed' } },
        {
            id: 'open',
            type: 'action.openTicket',
            position: { x: 0, y: 160 },
            data: { ticketType: 'support', title: 'Back again' },
        },
    ],
    [{ id: 'closed-open', source: 'closed', target: 'open' }]
);

/** Ticket Closed with nothing after it: REOPENER with its emitter taken out. */
const REOPENER_DISARMED = graphOf([REOPENER.nodes[0]]);

/** Ticket Opened (Support) on its own. */
const OPENED_ONLY = graphOf([
    {
        id: 'opened',
        type: 'trigger.ticketEvent',
        position: { x: 0, y: 0 },
        data: { event: 'opened', ticketType: 'support' },
    },
]);

/** Ticket Opened (Support) → Close Ticket: the other half. */
const CLOSER = graphOf(
    [
        ...OPENED_ONLY.nodes,
        { id: 'close', type: 'action.closeTicket', position: { x: 0, y: 160 }, data: { ticketId: '{{var.ticketId}}' } },
    ],
    [{ id: 'opened-close', source: 'opened', target: 'close' }]
);

let guildCount = 0;

/** A guild no other case has touched. */
function freshGuild(): string {
    guildCount += 1;
    return `loop-guild-${guildCount}`;
}

function app(guildId: string): Hono<AppEnv> {
    const outer = new Hono<AppEnv>();
    outer.use('*', async (c, next) => {
        c.set('guild', { id: guildId } as never);
        c.set('user', { ...OPERATOR, manageableGuildIds: [guildId] });
        await next();
    });
    outer.route('/', flowRoutes());
    outer.onError((_error, c) => c.json({ error: 'Internal error.' }, 500));
    return outer;
}

async function put<T>(guildId: string, flowId: string, body: unknown): Promise<Reply<T>> {
    const response = await app(guildId).request(`/${guildId}/flows/${flowId}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
    });
    return { status: response.status, body: (await response.json()) as T };
}

/** A flow stored straight through the repo, on or off — as a guild could hold it before this check. */
async function stored(guildId: string, name: string, graph: FlowGraph, enabled: boolean): Promise<string> {
    const flow = await flowsRepo.create({ guildId, name, graph, enabled });
    return flow.flowId;
}

async function reread(flowId: string) {
    const flow = await flowsRepo.getByFlowId(flowId);
    if (!flow) throw new Error(`flow ${flowId} vanished`);
    return flow;
}

beforeAll(async () => {
    await migrateTestDatabase();
    await ensureBlocksDiscovered();
});

describe('going live into a loop', () => {
    it('refuses a switch-on, names the loop, and leaves the flow off', async () => {
        const guildId = freshGuild();
        const flowId = await stored(guildId, 'Bouncer', SELF_LOOP, false);

        const refused = await put<RefusalBody>(guildId, flowId, { enabled: true });

        expect(refused.status).toBe(400);
        expect(refused.body).toEqual({
            error:
                'That would make this flow set itself off in a loop: "Bouncer" (Kick Member) starts "Bouncer" again. ' +
                "Change it so it doesn't.",
            issues: [],
        });
        expect((await reread(flowId)).enabled).toBe(false);
    });

    it('refuses a graph saved onto a live flow, and keeps the stored graph', async () => {
        const guildId = freshGuild();
        const flowId = await stored(guildId, 'Bouncer', LONE_LEAVE, true);

        const refused = await put<RefusalBody>(guildId, flowId, { graph: SELF_LOOP });

        expect(refused.status).toBe(400);
        expect(refused.body.issues).toEqual([]);
        expect((await reread(flowId)).graph).toEqual(LONE_LEAVE);
    });

    it('refuses an edit to one flow that closes a loop with another live one, naming both', async () => {
        const guildId = freshGuild();
        await stored(guildId, 'Reopener', REOPENER, true);
        const closerId = await stored(guildId, 'Closer', OPENED_ONLY, true);

        const refused = await put<RefusalBody>(guildId, closerId, { name: 'Closer, armed', graph: CLOSER });

        expect(refused.status).toBe(400);
        // Named in the shape the write would leave it in: the new name, from the saved flow.
        expect(refused.body.error).toBe(
            'That would make a loop between flows: "Closer, armed" (Close Ticket) starts "Reopener" → ' +
                '"Reopener" (Open Ticket) starts "Closer, armed" again. Change one of them, or switch one off.'
        );
        expect(refused.body.issues).toEqual([]);
        expect(await reread(closerId)).toMatchObject({ name: 'Closer', graph: OPENED_ONLY });
    });

    it('saves a live edit that breaks a loop it is already in', async () => {
        // Judged against its own stored row, the old graph would refuse the very edit
        // that takes the loop apart.
        const guildId = freshGuild();
        const reopenerId = await stored(guildId, 'Reopener', REOPENER, true);
        await stored(guildId, 'Closer', CLOSER, true);

        const saved = await put<FlowBody>(guildId, reopenerId, { graph: REOPENER_DISARMED });

        expect(saved.status).toBe(200);
        expect(saved.body.savedAs).toBe('flow');
        expect((await reread(reopenerId)).graph).toEqual(REOPENER_DISARMED);
    });

    it('ignores flows that are off, which cannot run', async () => {
        const guildId = freshGuild();
        await stored(guildId, 'Reopener', REOPENER, false);
        const closerId = await stored(guildId, 'Closer', CLOSER, false);

        const switched = await put<FlowBody>(guildId, closerId, { enabled: true });

        expect(switched.status).toBe(200);
        expect(switched.body.enabled).toBe(true);
    });
});

describe('what is never refused for a loop', () => {
    it('switching a looping flow off', async () => {
        const guildId = freshGuild();
        const flowId = await stored(guildId, 'Bouncer', SELF_LOOP, true);

        const switched = await put<FlowBody>(guildId, flowId, { enabled: false });

        expect(switched.status).toBe(200);
        expect(switched.body.enabled).toBe(false);
    });

    it('renaming one', async () => {
        const guildId = freshGuild();
        const flowId = await stored(guildId, 'Bouncer', SELF_LOOP, true);

        const renamed = await put<FlowBody>(guildId, flowId, { name: 'Bouncer, renamed' });

        expect(renamed.status).toBe(200);
        expect(renamed.body.name).toBe('Bouncer, renamed');
    });

    it('re-sending enabled: true to one already on, with no graph', async () => {
        const guildId = freshGuild();
        const flowId = await stored(guildId, 'Bouncer', SELF_LOOP, true);

        const resent = await put<FlowBody>(guildId, flowId, { enabled: true });

        expect(resent.status).toBe(200);
        expect(resent.body.enabled).toBe(true);
    });

    it('saving a looping graph onto a flow that is off', async () => {
        const guildId = freshGuild();
        const flowId = await stored(guildId, 'Bouncer', LONE_LEAVE, false);

        const saved = await put<FlowBody>(guildId, flowId, { graph: SELF_LOOP });

        expect(saved.status).toBe(200);
        expect((await reread(flowId)).graph).toEqual(SELF_LOOP);
    });

    it('a live save that lands as the saver’s draft, which does not go live', async () => {
        const guildId = freshGuild();
        const flowId = await stored(guildId, 'Bouncer', LONE_LEAVE, true);
        // Still a loop, and incomplete too: a DM with nothing to say.
        const unfinishedLoop = graphOf(
            [...SELF_LOOP.nodes, { id: 'dm', type: 'action.sendDM', position: { x: 0, y: 320 }, data: { message: '' } }],
            [...SELF_LOOP.edges, { id: 'kick-dm', source: 'kick', target: 'dm' }]
        );

        const saved = await put<FlowBody>(guildId, flowId, { graph: unfinishedLoop });

        expect(saved.status).toBe(200);
        expect(saved.body.savedAs).toBe('draft');
        expect((await reread(flowId)).graph).toEqual(LONE_LEAVE);
    });
});
