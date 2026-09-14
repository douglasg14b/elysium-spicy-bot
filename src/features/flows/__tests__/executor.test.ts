import { beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'crypto';
import { ensureBlocksDiscovered } from '../blocks/registry';
import { executeFlow } from '../engine/executor';
import { hasCycle, validateAuthoredGraph, validateFlowGraph } from '../engine/graphValidation';
import { FLOW_MAX_NODE_VISITS } from '../constants';
import { buildOnboardingFlowGraph } from '../templates/onboardingFlow';
import { FLOW_GRAPH_VERSION, type FlowGraph } from '../data/flowGraph';
import { CONDITION_HAS_ROLE } from '../blocks/conditionHasRole';
import { TRIGGER_BUTTON_CLICK } from '../blocks/triggerButtonClick';
import { ACTION_SEND_DM } from '../blocks/actionSendDM';
import { ACTION_ASSIGN_ROLE } from '../blocks/actionAssignRole';
import { ACTION_WAIT_FOR_EVENT } from '../blocks/actionWaitForEvent';
import { CONDITION_IN_CHANNEL } from '../blocks/conditionInChannel';
import { TRIGGER_MEMBER_JOIN } from '../blocks/triggerMemberJoin';
import type { FlowRunSeed } from '../blocks/types';
import { sentCopy } from './support/sentCopy';

const MEMBER_ROLE_ID = 'role-member-123';
const WELCOME_TEXT = 'Welcome to the dungeon, darling. 😈';

interface MockContext {
    context: FlowRunSeed;
    rolesAdd: ReturnType<typeof vi.fn>;
    userSend: ReturnType<typeof vi.fn>;
}

function makeContext(options: { hasRoles?: string[] } = {}): MockContext {
    const rolesAdd = vi.fn().mockResolvedValue(undefined);
    const userSend = vi.fn().mockResolvedValue(undefined);
    const roleCache = new Set(options.hasRoles ?? []);

    const user = { send: userSend };
    const subject = {
        user,
        roles: {
            add: rolesAdd,
            cache: { has: (id: string) => roleCache.has(id) },
        },
    } as unknown as FlowRunSeed['subject'];

    const context: FlowRunSeed = {
        client: {} as FlowRunSeed['client'],
        guild: { id: 'guild-1' } as FlowRunSeed['guild'],
        subject,
        variables: {},
    };

    return { context, rolesAdd, userSend };
}

// The executor looks blocks up in the registry, which is populated by scanning
// the blocks tree rather than by importing a static array.
beforeAll(ensureBlocksDiscovered);

describe('flow executor', () => {
    it('runs the onboarding flow: assigns the Member role then DMs the welcome text', async () => {
        const { graph, nodeIds } = buildOnboardingFlowGraph({
            memberRoleId: MEMBER_ROLE_ID,
            welcomeMessage: WELCOME_TEXT,
        });
        const { context, rolesAdd, userSend } = makeContext();

        const result = await executeFlow('flow-onboarding', graph, nodeIds.trigger, context);

        expect(result.status).toBe('success');
        expect(rolesAdd).toHaveBeenCalledTimes(1);
        expect(rolesAdd).toHaveBeenCalledWith(MEMBER_ROLE_ID);
        expect(userSend).toHaveBeenCalledTimes(1);
        expect(sentCopy(userSend)).toContain(WELCOME_TEXT);
        // trigger -> assignRole -> sendDM
        expect(result.visitedNodeIds).toEqual([nodeIds.trigger, nodeIds.assignRole, nodeIds.sendDM]);
    });

    it('routes a condition node down the true branch when the member has the role', async () => {
        const graph = buildConditionGraph();
        const { context, rolesAdd, userSend } = makeContext({ hasRoles: [MEMBER_ROLE_ID] });

        const result = await executeFlow('flow-cond', graph, 'trigger', context);

        expect(result.status).toBe('success');
        // true branch -> sendDM only, no role assignment
        expect(sentCopy(userSend)).toContain('you already have it');
        expect(rolesAdd).not.toHaveBeenCalled();
        expect(result.log.find((l) => l.kind === 'condition')?.branch).toBe('true');
    });

    it('routes a condition node down the false branch when the member lacks the role', async () => {
        const graph = buildConditionGraph();
        const { context, rolesAdd, userSend } = makeContext({ hasRoles: [] });

        const result = await executeFlow('flow-cond', graph, 'trigger', context);

        expect(result.status).toBe('success');
        // false branch -> assignRole only, no DM
        expect(rolesAdd).toHaveBeenCalledWith(MEMBER_ROLE_ID);
        expect(userSend).not.toHaveBeenCalled();
        expect(result.log.find((l) => l.kind === 'condition')?.branch).toBe('false');
    });

    it('accepts a cyclic graph — loops are legal, the visit cap is the guard', () => {
        const cyclic = buildCyclicGraph();

        const result = validateFlowGraph(cyclic);
        expect(result.valid).toBe(true);
        // The cycle is still *detectable*, it just is not an error any more.
        expect(hasCycle(cyclic)).toBe(true);
    });

    it('stops a runaway cyclic flow at the visit cap', async () => {
        const { context, rolesAdd } = makeContext();

        const result = await executeFlow('flow-loop', buildCyclicGraph(), 'node-a', context);

        expect(result.status).toBe('error');
        expect(result.error).toContain('Exceeded max node visits');
        expect(result.visitedNodeIds).toHaveLength(FLOW_MAX_NODE_VISITS);
        // It looped, it did not run away: the action ran once per pass, no more.
        expect(rolesAdd.mock.calls.length).toBeLessThanOrEqual(FLOW_MAX_NODE_VISITS);
    });

    it('captures a per-node error without throwing', async () => {
        const { graph, nodeIds } = buildOnboardingFlowGraph({
            memberRoleId: MEMBER_ROLE_ID,
            welcomeMessage: WELCOME_TEXT,
        });
        const { context, rolesAdd } = makeContext();
        rolesAdd.mockRejectedValueOnce(new Error('Missing Permissions'));

        const result = await executeFlow('flow-onboarding', graph, nodeIds.trigger, context);

        expect(result.status).toBe('error');
        expect(result.error).toContain('Missing Permissions');
    });
});

/**
 * Two edges leaving one handle is rejected at save time, naming the node.
 *
 * Each case is a different handle *kind*, because a fix scoped to one of them
 * leaves the requirement violated while looking done: the unnamed default exit,
 * a condition's named branch, and a suspending block's declared timeout.
 */
describe('a handle with more than one outgoing edge', () => {
    it('rejects two edges leaving an unhandled default output', () => {
        const graph = buildConditionGraph();
        graph.edges.push({ id: 'e4', source: 'trigger', target: 'assign' });

        const result = validateAuthoredGraph(graph);

        expect(result.valid).toBe(false);
        if (result.valid) return;
        expect(result.errors.join('\n')).toMatch(/Node trigger has 2 edges leaving its default output/);
    });

    it('rejects two edges leaving the same true handle', () => {
        const graph = buildConditionGraph();
        graph.edges.push({ id: 'e4', source: 'cond', sourceHandle: 'true', target: 'assign' });

        const result = validateAuthoredGraph(graph);

        expect(result.valid).toBe(false);
        if (result.valid) return;
        expect(result.errors.join('\n')).toMatch(/Node cond has 2 edges leaving its "true" output/);
    });

    it('rejects two edges leaving a declared timeout handle', () => {
        const graph: FlowGraph = {
            version: FLOW_GRAPH_VERSION,
            nodes: [
                { id: 'trigger', type: TRIGGER_BUTTON_CLICK, position: { x: 0, y: 0 }, data: { label: 'Go' } },
                {
                    id: 'wait',
                    type: ACTION_WAIT_FOR_EVENT,
                    position: { x: 200, y: 0 },
                    data: { eventKind: 'memberJoin', timeoutMs: 60_000 },
                },
                { id: 'dm', type: ACTION_SEND_DM, position: { x: 400, y: 0 }, data: { message: 'hi' } },
                {
                    id: 'assign',
                    type: ACTION_ASSIGN_ROLE,
                    position: { x: 400, y: 100 },
                    data: { roleId: MEMBER_ROLE_ID },
                },
            ],
            edges: [
                { id: 'e1', source: 'trigger', target: 'wait' },
                { id: 'e2', source: 'wait', sourceHandle: 'timeout', target: 'dm' },
                { id: 'e3', source: 'wait', sourceHandle: 'timeout', target: 'assign' },
            ],
        };

        const result = validateAuthoredGraph(graph);

        expect(result.valid).toBe(false);
        if (result.valid) return;
        expect(result.errors.join('\n')).toMatch(/Node wait has 2 edges leaving its "timeout" output/);
    });

    it('accepts a node whose several edges each leave a different handle', () => {
        // The ordinary condition shape: one edge on `true`, one on `false`.
        expect(validateAuthoredGraph(buildConditionGraph()).valid).toBe(true);
    });

    it('does not reject a stored graph on read, so one bad flow cannot hide the rest', () => {
        // Fan-out is an authoring mistake, not corruption. Enforcing it on the
        // read path would make every flow in a guild unloadable the moment one
        // old row stopped satisfying a rule added later.
        const graph = buildConditionGraph();
        graph.edges.push({ id: 'e4', source: 'cond', sourceHandle: 'true', target: 'assign' });

        expect(validateFlowGraph(graph).valid).toBe(true);
    });
});

describe('an edge leaving a handle its block never declared', () => {
    it('is rejected at save time, naming the outputs the block does have', () => {
        // Previously this saved cleanly, then the run reported success having
        // silently skipped the action: the old resolver fell back to `edges[0]`.
        const graph = buildConditionGraph();
        graph.edges = [{ id: 'e1', source: 'trigger', sourceHandle: 'out', target: 'cond' }];

        const result = validateAuthoredGraph(graph);

        expect(result.valid).toBe(false);
        if (result.valid) return;
        expect(result.errors.join('\n')).toMatch(/Node trigger .* has an edge leaving its "out" output/);
    });
});

describe('a block that needs something the run cannot supply', () => {
    /**
     * trigger.memberJoin -> condition.inChannel. A join happens nowhere in
     * particular, so the channel the condition asks about never exists.
     *
     * `condition.inChannel` is the exemplar because it is the one shipped block
     * whose requirement a graph can actually violate. It used to require an
     * `interaction`, which made it the exemplar for that rule instead; it now
     * reads the run's own channel, which is the whole point of the retarget —
     * asking the interaction meant answering "no" on every resumed run.
     */
    function gatewayStartedGraph(): FlowGraph {
        return {
            version: FLOW_GRAPH_VERSION,
            nodes: [
                { id: 'trigger', type: TRIGGER_MEMBER_JOIN, position: { x: 0, y: 0 }, data: {} },
                {
                    id: 'where',
                    type: CONDITION_IN_CHANNEL,
                    position: { x: 200, y: 0 },
                    data: { channelId: 'channel-1' },
                },
            ],
            edges: [{ id: 'e1', source: 'trigger', target: 'where' }],
        };
    }

    it('is rejected when every path to it starts from a trigger that cannot supply it', () => {
        const result = validateAuthoredGraph(gatewayStartedGraph());

        expect(result.valid).toBe(false);
        if (result.valid) return;
        expect(result.errors.join('\n')).toMatch(/needs "channel" from the run/);
    });

    it('is accepted when a trigger that does supply it reaches the block', () => {
        const graph = gatewayStartedGraph();
        graph.nodes[0] = {
            id: 'trigger',
            type: TRIGGER_BUTTON_CLICK,
            position: { x: 0, y: 0 },
            data: { label: 'Go' },
        };

        expect(validateAuthoredGraph(graph).valid).toBe(true);
    });

    it('is rejected when the only path to it passes through a block that parks', () => {
        // However the run originally started, a resumed one cannot answer this.
        // The snapshot persists `{guildId, userId}` and nothing else, so a woken
        // run does not remember where it was — and a block that silently took the
        // false branch every time would be the M1 bug all over again, moved.
        //
        // This case is the one that catches a premature relaxation: the moment a
        // channel is persisted with the run, this graph becomes legal and this
        // assertion is the thing that must be deliberately changed.
        const graph = gatewayStartedGraph();
        graph.nodes[0] = {
            id: 'trigger',
            type: TRIGGER_BUTTON_CLICK,
            position: { x: 0, y: 0 },
            data: { label: 'Go' },
        };
        graph.nodes.push({
            id: 'wait',
            type: ACTION_WAIT_FOR_EVENT,
            position: { x: 100, y: 0 },
            data: { eventKind: 'memberJoin' },
        });
        graph.edges = [
            { id: 'e1', source: 'trigger', target: 'wait' },
            { id: 'e2', source: 'wait', target: 'where' },
        ];

        const result = validateAuthoredGraph(graph);

        expect(result.valid).toBe(false);
        if (result.valid) return;
        expect(result.errors.join('\n')).toMatch(/does not yet remember where it was/);
    });

    it('is rejected even when a good path also exists, because the bad one still runs', () => {
        // The case existence-based reachability gets wrong: reachable from the
        // gateway trigger as well as the button, and the gateway lap has no
        // channel. Accepting it means a graph that validates clean and then
        // behaves differently depending on which trigger fired.
        const graph: FlowGraph = {
            version: FLOW_GRAPH_VERSION,
            nodes: [
                { id: 'trigger', type: TRIGGER_BUTTON_CLICK, position: { x: 0, y: 0 }, data: { label: 'Go' } },
                { id: 'joined', type: TRIGGER_MEMBER_JOIN, position: { x: 0, y: 100 }, data: {} },
                {
                    id: 'where',
                    type: CONDITION_IN_CHANNEL,
                    position: { x: 200, y: 0 },
                    data: { channelId: 'channel-1' },
                },
            ],
            edges: [
                { id: 'e1', source: 'trigger', target: 'where' },
                { id: 'e2', source: 'joined', target: 'where' },
            ],
        };

        const result = validateAuthoredGraph(graph);

        expect(result.valid).toBe(false);
        if (result.valid) return;
        expect(result.errors.join('\n')).toMatch(/happens in no particular channel/);
    });

    it('tolerates a back-edge whose every lap still supplies the requirement', () => {
        // A loop is not itself a problem. This one is entered only from a button,
        // so the channel is there on every lap.
        const graph = gatewayStartedGraph();
        graph.nodes[0] = {
            id: 'trigger',
            type: TRIGGER_BUTTON_CLICK,
            position: { x: 0, y: 0 },
            data: { label: 'Go' },
        };
        graph.edges.push({ id: 'e2', source: 'where', sourceHandle: 'true', target: 'where' });

        expect(validateAuthoredGraph(graph).valid).toBe(true);
    });
});

/** trigger -> assignRole -> back to trigger. Legal, and bounded by the visit cap. */
function buildCyclicGraph(): FlowGraph {
    const a = 'node-a';
    const b = 'node-b';
    return {
        version: FLOW_GRAPH_VERSION,
        nodes: [
            { id: a, type: TRIGGER_BUTTON_CLICK, position: { x: 0, y: 0 }, data: { label: 'Go' } },
            { id: b, type: ACTION_ASSIGN_ROLE, position: { x: 100, y: 0 }, data: { roleId: MEMBER_ROLE_ID } },
        ],
        edges: [
            { id: randomUUID(), source: a, target: b },
            { id: randomUUID(), source: b, target: a }, // back-edge -> cycle
        ],
    };
}

/**
 * trigger -> condition.hasRole
 *   true  -> sendDM("you already have it")
 *   false -> assignRole(MEMBER_ROLE_ID)
 */
function buildConditionGraph(): FlowGraph {
    return {
        version: FLOW_GRAPH_VERSION,
        nodes: [
            { id: 'trigger', type: TRIGGER_BUTTON_CLICK, position: { x: 0, y: 0 }, data: { label: 'Check' } },
            { id: 'cond', type: CONDITION_HAS_ROLE, position: { x: 200, y: 0 }, data: { roleId: MEMBER_ROLE_ID } },
            { id: 'dm', type: ACTION_SEND_DM, position: { x: 400, y: -60 }, data: { message: 'you already have it' } },
            {
                id: 'assign',
                type: ACTION_ASSIGN_ROLE,
                position: { x: 400, y: 60 },
                data: { roleId: MEMBER_ROLE_ID },
            },
        ],
        edges: [
            { id: 'e1', source: 'trigger', target: 'cond' },
            { id: 'e2', source: 'cond', sourceHandle: 'true', target: 'dm' },
            { id: 'e3', source: 'cond', sourceHandle: 'false', target: 'assign' },
        ],
    };
}
