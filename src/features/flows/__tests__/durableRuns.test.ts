import type { Client } from 'discord.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FLOW_MAX_NODE_VISITS } from '../constants';
import { FLOW_GRAPH_VERSION, type FlowGraph } from '../data/flowGraph';
import type { CreateFlowRunInput, ParkFlowRunInput } from '../data/flowRunsRepo';
import type { FlowRunEntity } from '../data/flowRunsSchema';
import type { FlowEntity } from '../data/flowsSchema';
import { executeFlow, executeFlowSegment } from '../engine/executor';
import { resumeFlowRun } from '../engine/flowRunResume';
import { resumeWaitingRunsForEvent } from '../engine/waitingRunDispatch';
import { ACTION_ASSIGN_ROLE } from '../nodes/actionAssignRole';
import { ACTION_DELAY } from '../nodes/actionDelay';
import { ACTION_SEND_DM } from '../nodes/actionSendDM';
import { ACTION_WAIT_FOR_EVENT } from '../nodes/actionWaitForEvent';
import { TRIGGER_BUTTON_CLICK } from '../nodes/triggerButtonClick';
import type { FlowRunContext } from '../nodes/types';

const GUILD_ID = 'guild-1';
const USER_ID = 'user-1';
const ROLE_ID = 'role-member';
const DELAY_MS = 60 * 60 * 1000; // 1 hour
const DM_TEXT = 'the wait is over';

/** trigger -> assignRole -> delay(1h) -> sendDM */
function buildDelayGraph(): FlowGraph {
    return {
        version: FLOW_GRAPH_VERSION,
        nodes: [
            { id: 'trigger', type: TRIGGER_BUTTON_CLICK, position: { x: 0, y: 0 }, data: { label: 'Go' } },
            { id: 'assign', type: ACTION_ASSIGN_ROLE, position: { x: 100, y: 0 }, data: { roleId: ROLE_ID } },
            { id: 'delay', type: ACTION_DELAY, position: { x: 200, y: 0 }, data: { durationMs: DELAY_MS } },
            { id: 'dm', type: ACTION_SEND_DM, position: { x: 300, y: 0 }, data: { message: DM_TEXT } },
        ],
        edges: [
            { id: 'e1', source: 'trigger', target: 'assign' },
            { id: 'e2', source: 'assign', target: 'delay' },
            { id: 'e3', source: 'delay', target: 'dm' },
        ],
    };
}

/** trigger -> waitForEvent(memberJoin, 1h timeout) -> sendDM, plus a timeout branch. */
function buildWaitGraph(options: { withTimeoutBranch?: boolean; timeoutMs?: number } = {}): FlowGraph {
    const nodes: FlowGraph['nodes'] = [
        { id: 'trigger', type: TRIGGER_BUTTON_CLICK, position: { x: 0, y: 0 }, data: { label: 'Go' } },
        {
            id: 'wait',
            type: ACTION_WAIT_FOR_EVENT,
            position: { x: 100, y: 0 },
            data: {
                eventKind: 'memberJoin',
                ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
            },
        },
        { id: 'dm', type: ACTION_SEND_DM, position: { x: 200, y: 0 }, data: { message: DM_TEXT } },
    ];

    const edges: FlowGraph['edges'] = [
        { id: 'e1', source: 'trigger', target: 'wait' },
        { id: 'e2', source: 'wait', target: 'dm' },
    ];

    if (options.withTimeoutBranch) {
        nodes.push({
            id: 'timeout-dm',
            type: ACTION_SEND_DM,
            position: { x: 200, y: 100 },
            data: { message: 'timed out' },
        });
        edges.push({ id: 'e3', source: 'wait', sourceHandle: 'timeout', target: 'timeout-dm' });
    }

    return { version: FLOW_GRAPH_VERSION, nodes, edges };
}

interface MockContext {
    context: FlowRunContext;
    rolesAdd: ReturnType<typeof vi.fn>;
    userSend: ReturnType<typeof vi.fn>;
}

function makeContext(): MockContext {
    const rolesAdd = vi.fn().mockResolvedValue(undefined);
    const userSend = vi.fn().mockResolvedValue(undefined);

    const user = { id: USER_ID, send: userSend } as unknown as FlowRunContext['user'];
    const member = {
        id: USER_ID,
        user,
        roles: { add: rolesAdd, cache: { has: () => false } },
    } as unknown as FlowRunContext['member'];

    return {
        context: {
            client: {} as FlowRunContext['client'],
            guild: { id: GUILD_ID } as FlowRunContext['guild'],
            member,
            user,
        },
        rolesAdd,
        userSend,
    };
}

/**
 * A client whose guild/member fetches succeed, unless `memberLeft` is set — in
 * which case `members.fetch` rejects the way discord.js does for a departed
 * member.
 */
function makeClient(options: { memberLeft?: boolean; guildGone?: boolean } = {}): {
    client: Client;
    userSend: ReturnType<typeof vi.fn>;
    rolesAdd: ReturnType<typeof vi.fn>;
} {
    const userSend = vi.fn().mockResolvedValue(undefined);
    const rolesAdd = vi.fn().mockResolvedValue(undefined);

    const member = {
        id: USER_ID,
        user: { id: USER_ID, send: userSend },
        roles: { add: rolesAdd, cache: { has: () => false } },
    };

    const guild = {
        id: GUILD_ID,
        members: {
            fetch: options.memberLeft
                ? vi.fn().mockRejectedValue(new Error('Unknown Member'))
                : vi.fn().mockResolvedValue(member),
        },
    };

    const client = {
        user: { id: 'bot-1' },
        guilds: {
            cache: { get: () => (options.guildGone ? undefined : guild) },
            fetch: options.guildGone
                ? vi.fn().mockRejectedValue(new Error('Unknown Guild'))
                : vi.fn().mockResolvedValue(guild),
        },
    } as unknown as Client;

    return { client, userSend, rolesAdd };
}

function makeFlowEntity(graph: FlowGraph, flowId = 'flow-1'): FlowEntity {
    return {
        id: 1,
        flowId,
        guildId: GUILD_ID,
        name: 'Durable',
        enabled: true,
        graph,
        entityVersion: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
    } as FlowEntity;
}

function makeRunEntity(overrides: Partial<FlowRunEntity> = {}): FlowRunEntity {
    return {
        id: 1,
        runId: 'run-1',
        flowId: 'flow-1',
        guildId: GUILD_ID,
        status: 'suspended',
        claimedAt: null,
        resumeNodeId: 'dm',
        wakeAt: new Date(Date.now() - 1000),
        waitKind: null,
        waitConfig: null,
        contextSnapshot: { guildId: GUILD_ID, userId: USER_ID },
        visitsUsed: 3,
        log: [],
        error: null,
        entityVersion: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
        ...overrides,
    } as FlowRunEntity;
}

/** What a lifecycle write recorded, without reaching for the repo's input types. */
type RecordedWrite = { runId: string; patch: Record<string, unknown> };

/**
 * A repo double capturing every write, so assertions read off plain objects.
 *
 * `claimForResume` mirrors the real conditional write: it only hands back a row
 * when the run is actually suspended, which is what makes a "someone else already
 * took it" path testable without a database.
 */
function makeRunsRepoDouble(run?: FlowRunEntity) {
    const created: CreateFlowRunInput[] = [];
    const updated: RecordedWrite[] = [];

    return {
        created,
        updated,
        create: vi.fn(async (input: CreateFlowRunInput) => {
            created.push(input);
            return makeRunEntity({ runId: 'run-created' });
        }),
        getByRunId: vi.fn(async () => run ?? null),
        claimForResume: vi.fn(async (runId: string) => {
            if (!run || run.status !== 'suspended') {
                return null;
            }
            updated.push({ runId, patch: { status: 'running' } });
            return { ...run, status: 'running', claimedAt: new Date() } as FlowRunEntity;
        }),
        releaseClaim: vi.fn(async (runId: string) => {
            updated.push({ runId, patch: { status: 'suspended', claimedAt: null } });
            return makeRunEntity({ runId });
        }),
        park: vi.fn(async (runId: string, patch: ParkFlowRunInput) => {
            updated.push({ runId, patch: { status: 'suspended', ...patch } });
            return makeRunEntity({ runId });
        }),
        complete: vi.fn(async (runId: string) => {
            updated.push({ runId, patch: { status: 'completed' } });
            return makeRunEntity({ runId, status: 'completed' });
        }),
        fail: vi.fn(async (runId: string, error: string) => {
            updated.push({ runId, patch: { status: 'failed', error } });
            return makeRunEntity({ runId, status: 'failed', error });
        }),
    };
}

describe('action.delay', () => {
    it('suspends with the node after the delay as resumeNodeId and wakeAt ≈ now + durationMs', async () => {
        const { context, rolesAdd, userSend } = makeContext();
        const before = Date.now();

        const outcome = await executeFlowSegment('flow-1', buildDelayGraph(), context, {
            startNodeId: 'trigger',
            requireTrigger: true,
        });

        expect(outcome.kind).toBe('suspended');
        if (outcome.kind !== 'suspended') return;

        expect(outcome.suspension.resumeNodeId).toBe('dm');
        expect(outcome.suspension.wakeAt).toBeInstanceOf(Date);
        const wakeMs = outcome.suspension.wakeAt!.getTime();
        expect(wakeMs).toBeGreaterThanOrEqual(before + DELAY_MS);
        expect(wakeMs).toBeLessThanOrEqual(Date.now() + DELAY_MS);

        // Everything before the delay ran; nothing after it did.
        expect(rolesAdd).toHaveBeenCalledWith(ROLE_ID);
        expect(userSend).not.toHaveBeenCalled();
        // trigger + assign + delay
        expect(outcome.suspension.visitsUsed).toBe(3);
    });

    it('persists a suspended run row through executeFlow when it suspends', async () => {
        const { context } = makeContext();
        const runsRepo = makeRunsRepoDouble();

        const result = await executeFlow('flow-1', buildDelayGraph(), 'trigger', context, async (suspension) => {
            await runsRepo.create({
                flowId: 'flow-1',
                guildId: context.guild.id,
                contextSnapshot: { guildId: context.guild.id, userId: context.user.id },
                resumeNodeId: suspension.resumeNodeId,
                wakeAt: suspension.wakeAt ?? null,
                visitsUsed: suspension.visitsUsed,
                log: suspension.log,
            });
        });

        // The segment that ran succeeded; the rest is the poller's job.
        expect(result.status).toBe('success');
        expect(runsRepo.created).toHaveLength(1);
        expect(runsRepo.created[0]?.resumeNodeId).toBe('dm');
        // Only guildId + userId are snapshotted — no interaction, no member object.
        expect(runsRepo.created[0]?.contextSnapshot).toEqual({ guildId: GUILD_ID, userId: USER_ID });
    });

    it('completes instead of sleeping when nothing follows the delay', async () => {
        const graph = buildDelayGraph();
        graph.edges = graph.edges.filter((edge) => edge.source !== 'delay');
        const { context } = makeContext();

        const outcome = await executeFlowSegment('flow-1', graph, context, {
            startNodeId: 'trigger',
            requireTrigger: true,
        });

        expect(outcome.kind).toBe('completed');
        if (outcome.kind !== 'completed') return;
        expect(outcome.result.status).toBe('success');
    });
});

describe('resuming a suspended run', () => {
    let flowsRepo: { getByFlowId: ReturnType<typeof vi.fn> };

    beforeEach(() => {
        flowsRepo = { getByFlowId: vi.fn().mockResolvedValue(makeFlowEntity(buildDelayGraph())) };
    });

    it('continues from resumeNodeId and completes, running the downstream action', async () => {
        const { client, userSend } = makeClient();
        const run = makeRunEntity({ resumeNodeId: 'dm' });
        const runsRepo = makeRunsRepoDouble(run);

        const outcome = await resumeFlowRun(client, run, 'timeout', { flowsRepo, flowRunsRepo: runsRepo });

        expect(outcome.status).toBe('completed');
        expect(userSend).toHaveBeenCalledWith(DM_TEXT);
        expect(runsRepo.complete).toHaveBeenCalledWith('run-1', expect.anything());
    });

    it('fails gracefully when the member has left the guild', async () => {
        const { client, userSend } = makeClient({ memberLeft: true });
        const run = makeRunEntity();
        const runsRepo = makeRunsRepoDouble(run);

        const outcome = await resumeFlowRun(client, run, 'timeout', { flowsRepo, flowRunsRepo: runsRepo });

        expect(outcome.status).toBe('failed');
        if (outcome.status !== 'failed') return;
        expect(outcome.error).toMatch(/no longer in guild/i);
        expect(runsRepo.fail).toHaveBeenCalledTimes(1);
        expect(userSend).not.toHaveBeenCalled();
    });

    it('fails gracefully when the guild is gone', async () => {
        const { client } = makeClient({ guildGone: true });
        const run = makeRunEntity();
        const runsRepo = makeRunsRepoDouble(run);

        const outcome = await resumeFlowRun(client, run, 'timeout', { flowsRepo, flowRunsRepo: runsRepo });

        expect(outcome.status).toBe('failed');
        if (outcome.status !== 'failed') return;
        expect(outcome.error).toMatch(/no longer available/i);
    });

    it('fails when the flow itself has been deleted', async () => {
        const { client } = makeClient();
        const run = makeRunEntity();
        const runsRepo = makeRunsRepoDouble(run);
        flowsRepo.getByFlowId.mockResolvedValue(null);

        const outcome = await resumeFlowRun(client, run, 'timeout', { flowsRepo, flowRunsRepo: runsRepo });

        expect(outcome.status).toBe('failed');
        if (outcome.status !== 'failed') return;
        expect(outcome.error).toMatch(/no longer exists/i);
    });

    it('skips a run that is no longer suspended, without touching it', async () => {
        const { client } = makeClient();
        const run = makeRunEntity({ status: 'completed' });
        const runsRepo = makeRunsRepoDouble(run);

        const outcome = await resumeFlowRun(client, run, 'timeout', { flowsRepo, flowRunsRepo: runsRepo });

        expect(outcome.status).toBe('skipped');
        expect(runsRepo.fail).not.toHaveBeenCalled();
        expect(runsRepo.complete).not.toHaveBeenCalled();
        // Losing the claim must not look like an error to the caller.
        expect(runsRepo.releaseClaim).not.toHaveBeenCalled();
    });
});

describe('visit budget across resumes', () => {
    it('fails with the max-visits error rather than resetting the budget', async () => {
        const { client, userSend } = makeClient();
        const flowsRepo = { getByFlowId: vi.fn().mockResolvedValue(makeFlowEntity(buildDelayGraph())) };
        const run = makeRunEntity({ visitsUsed: FLOW_MAX_NODE_VISITS });
        const runsRepo = makeRunsRepoDouble(run);

        const outcome = await resumeFlowRun(client, run, 'timeout', { flowsRepo, flowRunsRepo: runsRepo });

        expect(outcome.status).toBe('failed');
        if (outcome.status !== 'failed') return;
        expect(outcome.error).toContain('Exceeded max node visits');
        // The budget is spent, so the downstream action must NOT have run.
        expect(userSend).not.toHaveBeenCalled();
        expect(runsRepo.fail).toHaveBeenCalledWith('run-1', expect.stringContaining('Exceeded max node visits'), []);
    });

    it('carries prior visits into the resumed segment so a delayed loop still hits the cap', async () => {
        // A loop: trigger -> delay -> back to trigger. Resuming with one visit
        // left must exhaust the budget immediately rather than looping anew.
        const loop: FlowGraph = {
            version: FLOW_GRAPH_VERSION,
            nodes: [
                { id: 'trigger', type: TRIGGER_BUTTON_CLICK, position: { x: 0, y: 0 }, data: { label: 'Go' } },
                { id: 'delay', type: ACTION_DELAY, position: { x: 100, y: 0 }, data: { durationMs: DELAY_MS } },
            ],
            edges: [
                { id: 'e1', source: 'trigger', target: 'delay' },
                { id: 'e2', source: 'delay', target: 'trigger' },
            ],
        };
        const { context } = makeContext();

        const outcome = await executeFlowSegment('flow-loop', loop, context, {
            startNodeId: 'trigger',
            visitsUsed: FLOW_MAX_NODE_VISITS - 1,
        });

        expect(outcome.kind).toBe('completed');
        if (outcome.kind !== 'completed') return;
        expect(outcome.result.status).toBe('error');
        expect(outcome.result.error).toContain('Exceeded max node visits');
    });
});

describe('action.waitForEvent', () => {
    it('parks the run with waitKind and waitConfig set', async () => {
        const { context, userSend } = makeContext();

        const outcome = await executeFlowSegment('flow-1', buildWaitGraph({ timeoutMs: DELAY_MS }), context, {
            startNodeId: 'trigger',
            requireTrigger: true,
        });

        expect(outcome.kind).toBe('suspended');
        if (outcome.kind !== 'suspended') return;

        // The wait node itself is the resume point — the exit handle is chosen on wake.
        expect(outcome.suspension.resumeNodeId).toBe('wait');
        expect(outcome.suspension.waitKind).toBe('memberJoin');
        expect(outcome.suspension.waitConfig).toEqual({ eventKind: 'memberJoin', timeoutMs: DELAY_MS });
        expect(outcome.suspension.wakeAt).toBeInstanceOf(Date);
        expect(userSend).not.toHaveBeenCalled();
    });

    it('parks with no wakeAt when no timeout is configured', async () => {
        const { context } = makeContext();

        const outcome = await executeFlowSegment('flow-1', buildWaitGraph(), context, {
            startNodeId: 'trigger',
            requireTrigger: true,
        });

        expect(outcome.kind).toBe('suspended');
        if (outcome.kind !== 'suspended') return;
        expect(outcome.suspension.wakeAt).toBeUndefined();
    });

    it('resumes down the normal branch when a matching event arrives', async () => {
        const { client, userSend } = makeClient();
        const run = makeRunEntity({
            resumeNodeId: 'wait',
            waitKind: 'memberJoin',
            waitConfig: { eventKind: 'memberJoin' },
            wakeAt: null,
        });
        const runsRepo = makeRunsRepoDouble(run);
        const flowsRepo = { getByFlowId: vi.fn().mockResolvedValue(makeFlowEntity(buildWaitGraph())) };

        const outcome = await resumeFlowRun(client, run, 'event', { flowsRepo, flowRunsRepo: runsRepo });

        expect(outcome.status).toBe('completed');
        expect(userSend).toHaveBeenCalledWith(DM_TEXT);
    });

    it('follows the timeout branch when the wait expires', async () => {
        const { client, userSend } = makeClient();
        const run = makeRunEntity({ resumeNodeId: 'wait', waitKind: 'memberJoin' });
        const runsRepo = makeRunsRepoDouble(run);
        const flowsRepo = {
            getByFlowId: vi.fn().mockResolvedValue(makeFlowEntity(buildWaitGraph({ withTimeoutBranch: true }))),
        };

        const outcome = await resumeFlowRun(client, run, 'timeout', { flowsRepo, flowRunsRepo: runsRepo });

        expect(outcome.status).toBe('completed');
        expect(userSend).toHaveBeenCalledWith('timed out');
    });

    it('fails with a clear timeout error when there is no timeout branch', async () => {
        const { client, userSend } = makeClient();
        const run = makeRunEntity({ resumeNodeId: 'wait', waitKind: 'memberJoin' });
        const runsRepo = makeRunsRepoDouble(run);
        const flowsRepo = { getByFlowId: vi.fn().mockResolvedValue(makeFlowEntity(buildWaitGraph())) };

        const outcome = await resumeFlowRun(client, run, 'timeout', { flowsRepo, flowRunsRepo: runsRepo });

        expect(outcome.status).toBe('failed');
        if (outcome.status !== 'failed') return;
        expect(outcome.error).toMatch(/timed out/i);
        expect(outcome.error).toMatch(/timeout/i);
        expect(userSend).not.toHaveBeenCalled();
    });
});

describe('resumeWaitingRunsForEvent', () => {
    it('resumes a run whose guild, waitKind and user all match', async () => {
        const { client } = makeClient();
        const run = makeRunEntity({
            resumeNodeId: 'wait',
            waitKind: 'memberJoin',
            waitConfig: { eventKind: 'memberJoin' },
            wakeAt: null,
        });
        const flowRunsRepo = { findWaiting: vi.fn().mockResolvedValue([run]) };
        const resume = vi.fn().mockResolvedValue({ status: 'completed' });

        const resumed = await resumeWaitingRunsForEvent(
            client,
            { guildId: GUILD_ID, userId: USER_ID, eventKind: 'memberJoin' },
            { flowRunsRepo, resume }
        );

        expect(flowRunsRepo.findWaiting).toHaveBeenCalledWith({
            guildId: GUILD_ID,
            waitKind: 'memberJoin',
        });
        expect(resume).toHaveBeenCalledWith(client, run, 'event');
        expect(resumed).toBe(1);
    });

    it('does NOT resume a run parked for a different user', async () => {
        const { client, userSend } = makeClient();
        const run = makeRunEntity({
            resumeNodeId: 'wait',
            waitKind: 'memberJoin',
            contextSnapshot: { guildId: GUILD_ID, userId: 'someone-else' },
            wakeAt: null,
        });
        const flowRunsRepo = { findWaiting: vi.fn().mockResolvedValue([run]) };
        const resume = vi.fn().mockResolvedValue({ status: 'completed' });

        const resumed = await resumeWaitingRunsForEvent(
            client,
            { guildId: GUILD_ID, userId: USER_ID, eventKind: 'memberJoin' },
            { flowRunsRepo, resume }
        );

        expect(resumed).toBe(0);
        expect(resume).not.toHaveBeenCalled();
        expect(userSend).not.toHaveBeenCalled();
    });

    it('returns 0 without throwing when the lookup fails', async () => {
        const { client } = makeClient();
        const flowRunsRepo = { findWaiting: vi.fn().mockRejectedValue(new Error('db down')) };

        const resumed = await resumeWaitingRunsForEvent(
            client,
            { guildId: GUILD_ID, userId: USER_ID, eventKind: 'memberJoin' },
            { flowRunsRepo }
        );

        expect(resumed).toBe(0);
    });
});
