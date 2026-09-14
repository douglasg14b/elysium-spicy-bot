/**
 * The seam between the builder and the engine: a graph shaped exactly as the
 * browser serialises one, put through the save-time validation the API applies,
 * and then executed.
 *
 * Everything else in this suite starts from a graph a *test helper* built. That
 * proves the engine runs a well-formed graph; it does not prove the builder emits
 * one. The two were written against the same schema, but nothing had ever run the
 * browser's own output through the server's own checks — so a disagreement about,
 * say, an omitted `sourceHandle` or a config key the inspector writes but the
 * schema rejects would have shipped green.
 *
 * The graph literal below is deliberately *not* built by a helper. It is written
 * out the way `serialize()` in `FlowBuilderPage.tsx` emits it — `version`, `type`
 * from `node.data.nodeType`, rounded integer positions, `data` from
 * `node.data.config`, and edges whose `sourceHandle` is present only on a block
 * that declares named handles. If that shape drifts from what the builder sends,
 * this stops reflecting reality, so it names the function it mirrors.
 */

import { describe, expect, it, vi } from 'vitest';
import { executeFlow } from '../engine/executor';
import { validateFlowGraph, validateAuthoredGraph } from '../engine/graphValidation';
import { validateNodeData } from '../engine/nodeDataValidation';
import { ensureBlocksDiscovered } from '../blocks/registry';
import type { FlowGraph } from '../data/flowGraph';
import type { FlowRunSeed } from '../blocks/types';

const MEMBER_ROLE_ID = '900000000000000001';
const BOOSTER_ROLE_ID = '900000000000000002';

/**
 * A flow an admin could plausibly build in one sitting: a button opens it, a
 * condition forks on boost status, and each branch assigns a different role.
 *
 * Uses `condition.isBooster` on purpose — the block added to prove the
 * one-directory claim. Until this test it had never been run by the executor, only
 * rendered; a block that draws correctly and cannot execute would have passed every
 * other check in the milestone.
 */
function builderShapedGraph(): FlowGraph {
    return {
        version: 1,
        nodes: [
            {
                id: '11111111-1111-4111-8111-111111111111',
                type: 'trigger.buttonClick',
                position: { x: 120, y: 80 },
                data: { label: 'Get your roles', style: 'Primary' },
            },
            {
                id: '22222222-2222-4222-8222-222222222222',
                type: 'condition.isBooster',
                position: { x: 400, y: 80 },
                data: {},
            },
            {
                id: '33333333-3333-4333-8333-333333333333',
                type: 'action.assignRole',
                position: { x: 700, y: 20 },
                data: { roleId: BOOSTER_ROLE_ID },
            },
            {
                id: '44444444-4444-4444-8444-444444444444',
                type: 'action.assignRole',
                position: { x: 700, y: 160 },
                data: { roleId: MEMBER_ROLE_ID },
            },
        ],
        edges: [
            // No `sourceHandle`: the trigger declares one unnamed exit, and the
            // builder omits a falsy handle rather than sending an empty string.
            {
                id: 'edge-trigger',
                source: '11111111-1111-4111-8111-111111111111',
                target: '22222222-2222-4222-8222-222222222222',
            },
            {
                id: 'edge-yes',
                source: '22222222-2222-4222-8222-222222222222',
                sourceHandle: 'true',
                target: '33333333-3333-4333-8333-333333333333',
            },
            {
                id: 'edge-no',
                source: '22222222-2222-4222-8222-222222222222',
                sourceHandle: 'false',
                target: '44444444-4444-4444-8444-444444444444',
            },
        ],
    };
}

/**
 * The three checks `validateGraphForSave` in `flowRoutes.ts` runs, in its order.
 *
 * Mirrored rather than imported because that function is module-private to the
 * route file. The order matters and is asserted by using it: an unknown block type
 * must be reported as an unknown type, not as complaints about its handles.
 */
function validateAsSaveWould(graph: FlowGraph): readonly string[] {
    const structural = validateFlowGraph(graph);
    if (!structural.valid) return structural.errors;

    const nodeData = validateNodeData(structural.graph);
    if (!nodeData.valid) return nodeData.errors;

    const authored = validateAuthoredGraph(structural.graph);
    if (!authored.valid) return authored.errors;

    return [];
}

function makeContext(options: { boosting: boolean }): {
    context: FlowRunSeed;
    rolesAdd: ReturnType<typeof vi.fn>;
} {
    const rolesAdd = vi.fn().mockResolvedValue(undefined);
    const user = { send: vi.fn().mockResolvedValue(undefined) };
    const subject = {
        user,
        premiumSince: options.boosting ? new Date('2026-01-01T00:00:00Z') : null,
        roles: { add: rolesAdd, cache: { has: () => false } },
    } as unknown as FlowRunSeed['subject'];

    return {
        context: {
            client: {} as FlowRunSeed['client'],
            guild: { id: 'guild-1' } as FlowRunSeed['guild'],
            subject,
            variables: {},
        },
        rolesAdd,
    };
}

describe('a graph shaped the way the builder emits one', () => {
    it('passes the validation the save endpoint applies', async () => {
        await ensureBlocksDiscovered();
        expect(validateAsSaveWould(builderShapedGraph())).toEqual([]);
    });

    it('runs, and takes the branch the member qualifies for', async () => {
        await ensureBlocksDiscovered();
        const graph = builderShapedGraph();
        const triggerId = graph.nodes[0].id;

        const boosting = makeContext({ boosting: true });
        const boostingRun = await executeFlow('flow-round-trip', graph, triggerId, boosting.context);
        expect(boostingRun.status).toBe('success');
        expect(boosting.rolesAdd).toHaveBeenCalledWith(BOOSTER_ROLE_ID);

        const plain = makeContext({ boosting: false });
        const plainRun = await executeFlow('flow-round-trip', graph, triggerId, plain.context);
        expect(plainRun.status).toBe('success');
        expect(plain.rolesAdd).toHaveBeenCalledWith(MEMBER_ROLE_ID);
    });

    it('is rejected, naming the node, when the inspector left a field unset', async () => {
        await ensureBlocksDiscovered();
        const graph = builderShapedGraph();
        // What an author leaves behind by dropping a block and not configuring it.
        graph.nodes[2].data = {};

        const errors = validateAsSaveWould(graph);
        expect(errors.length).toBeGreaterThan(0);
        expect(errors.join(' ')).toContain(graph.nodes[2].id);
    });
});
