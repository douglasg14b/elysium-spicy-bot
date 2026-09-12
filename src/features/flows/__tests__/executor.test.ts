import { describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'crypto';
import { executeFlow } from '../engine/executor';
import { hasCycle, validateFlowGraph } from '../engine/graphValidation';
import { FLOW_MAX_NODE_VISITS } from '../constants';
import { buildOnboardingFlowGraph } from '../logic/onboardingFlow';
import { FLOW_GRAPH_VERSION, type FlowGraph } from '../data/flowGraph';
import { CONDITION_HAS_ROLE } from '../nodes/conditionHasRole';
import { TRIGGER_BUTTON_CLICK } from '../nodes/triggerButtonClick';
import { ACTION_SEND_DM } from '../nodes/actionSendDM';
import { ACTION_ASSIGN_ROLE } from '../nodes/actionAssignRole';
import type { FlowRunContext } from '../nodes/types';

const MEMBER_ROLE_ID = 'role-member-123';
const WELCOME_TEXT = 'Welcome to the dungeon, darling. 😈';

interface MockContext {
    context: FlowRunContext;
    rolesAdd: ReturnType<typeof vi.fn>;
    userSend: ReturnType<typeof vi.fn>;
}

function makeContext(options: { hasRoles?: string[] } = {}): MockContext {
    const rolesAdd = vi.fn().mockResolvedValue(undefined);
    const userSend = vi.fn().mockResolvedValue(undefined);
    const roleCache = new Set(options.hasRoles ?? []);

    const user = { send: userSend } as unknown as FlowRunContext['user'];
    const member = {
        user,
        roles: {
            add: rolesAdd,
            cache: { has: (id: string) => roleCache.has(id) },
        },
    } as unknown as FlowRunContext['member'];

    const context: FlowRunContext = {
        client: {} as FlowRunContext['client'],
        guild: { id: 'guild-1' } as FlowRunContext['guild'],
        member,
        user,
    };

    return { context, rolesAdd, userSend };
}

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
        expect(userSend).toHaveBeenCalledWith(WELCOME_TEXT);
        // trigger -> assignRole -> sendDM
        expect(result.visitedNodeIds).toEqual([nodeIds.trigger, nodeIds.assignRole, nodeIds.sendDM]);
    });

    it('routes a condition node down the true branch when the member has the role', async () => {
        const graph = buildConditionGraph();
        const { context, rolesAdd, userSend } = makeContext({ hasRoles: [MEMBER_ROLE_ID] });

        const result = await executeFlow('flow-cond', graph, 'trigger', context);

        expect(result.status).toBe('success');
        // true branch -> sendDM only, no role assignment
        expect(userSend).toHaveBeenCalledWith('you already have it');
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
