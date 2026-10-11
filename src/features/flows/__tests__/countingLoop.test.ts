import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ensureBlocksDiscovered, getBlockDefinition } from '../blocks/registry';
import { ACTION_SET_VARIABLE } from '../blocks/actionSetVariable';
import { CONDITION_COMPARE } from '../blocks/conditionCompare';
import type { FlowRunSeed } from '../blocks/types';
import { FLOW_MAX_NODE_VISITS } from '../constants';
import { FLOW_GRAPH_VERSION, type FlowEdge, type FlowGraph, type FlowNode } from '../data/flowGraph';
import { executeFlow } from '../engine/executor';
import { validateAuthoredGraph } from '../engine/graphValidation';

/**
 * A loop that counts and stops: Set Variable's "Add to number" and Compare, with a wire
 * back to an earlier block. Neither block knows about loops — the graph allows a cycle,
 * the visit cap bounds it, and these two make one that ends on purpose.
 */

beforeAll(ensureBlocksDiscovered);

afterEach(() => {
    vi.restoreAllMocks();
});

const node = (id: string, type: string, data: Record<string, unknown> = {}): FlowNode =>
    ({ id, type, position: { x: 0, y: 0 }, data }) as FlowNode;

const edge = (source: string, target: string, sourceHandle?: string): FlowEdge =>
    ({ id: `${source}-${sourceHandle ?? 'out'}-${target}`, source, target, ...(sourceHandle ? { sourceHandle } : {}) }) as FlowEdge;

/** member join -> count = 0 -> add 1 -> compare count `operator` `value`, Yes wired back to add. */
function countingLoop(operator: string, value: string): FlowGraph {
    return {
        version: FLOW_GRAPH_VERSION,
        nodes: [
            node('trigger', 'trigger.memberJoin'),
            node('zero', ACTION_SET_VARIABLE, { variableName: 'count', valueType: 'number', numberValue: '0' }),
            node('add', ACTION_SET_VARIABLE, { variableName: 'count', valueType: 'add', numberValue: '1' }),
            node('compare', CONDITION_COMPARE, { variableName: 'count', operator, value }),
        ],
        edges: [edge('trigger', 'zero'), edge('zero', 'add'), edge('add', 'compare'), edge('compare', 'add', 'true')],
    } as FlowGraph;
}

const seed: FlowRunSeed = {
    client: {} as FlowRunSeed['client'],
    guild: { id: 'guild-1' } as FlowRunSeed['guild'],
    subject: { id: 'user-1' } as FlowRunSeed['subject'],
    variables: {},
};

describe('a loop that counts', () => {
    it('saves: Compare reads the kindless count, and the wire back is legal', () => {
        const result = validateAuthoredGraph(countingLoop('lessThan', '3'));

        expect(result.valid ? [] : result.errors).toEqual([]);
    });

    it('goes round until the count reaches 3, then leaves by No', async () => {
        const compare = getBlockDefinition(CONDITION_COMPARE);
        if (!compare) throw new Error('condition.compare was not discovered');
        const spy = vi.spyOn(compare, 'run');

        const result = await executeFlow('flow-loop', countingLoop('lessThan', '3'), 'trigger', seed);

        expect(result.status).toBe('success');
        expect(result.log.filter((entry) => entry.nodeId === 'compare').map((entry) => entry.branch)).toEqual([
            'true',
            'true',
            'false',
        ]);
        expect(spy.mock.calls.map(([, context]) => context.variables.count)).toEqual([1, 2, 3]);
        expect(result.visitedNodeIds.length).toBeLessThan(FLOW_MAX_NODE_VISITS);
    });

    it('is refused at save when it checks first and only counts after, so the count is never set', () => {
        // trigger -> compare -> Yes -> add -> back to compare. Add writes on a path into
        // Compare, round the loop, but the first visit always finds nothing and leaves by
        // Not set — which is unwired, so every run would end as a quiet success.
        const graph = {
            version: FLOW_GRAPH_VERSION,
            nodes: [
                node('trigger', 'trigger.memberJoin'),
                node('compare', CONDITION_COMPARE, { variableName: 'count', operator: 'lessThan', value: '3' }),
                node('add', ACTION_SET_VARIABLE, { variableName: 'count', valueType: 'add', numberValue: '1' }),
            ],
            edges: [edge('trigger', 'compare'), edge('compare', 'add', 'true'), edge('add', 'compare')],
        } as FlowGraph;

        const result = validateAuthoredGraph(graph);

        expect(result.valid ? [] : result.errors).toEqual([
            expect.stringMatching(
                /"Variable" set to "count", but every block that records it only runs after this one, so the first time the run gets here it is never set\. Set it before this block\.$/
            ),
        ]);
    });

    it('saves when the count is first added to before the check, starting from 0', () => {
        // trigger -> add -> compare -> Yes -> add: Add runs before Compare's first visit.
        const graph = {
            version: FLOW_GRAPH_VERSION,
            nodes: [
                node('trigger', 'trigger.memberJoin'),
                node('add', ACTION_SET_VARIABLE, { variableName: 'count', valueType: 'add', numberValue: '1' }),
                node('compare', CONDITION_COMPARE, { variableName: 'count', operator: 'lessThan', value: '3' }),
            ],
            edges: [edge('trigger', 'add'), edge('add', 'compare'), edge('compare', 'add', 'true')],
        } as FlowGraph;

        const result = validateAuthoredGraph(graph);

        expect(result.valid ? [] : result.errors).toEqual([]);
    });

    it('fails at the visit cap when the comparison never says No', async () => {
        const result = await executeFlow('flow-loop', countingLoop('moreThan', '0'), 'trigger', seed);

        expect(result.status).toBe('error');
        expect(result.error).toBe(`Exceeded max node visits (${FLOW_MAX_NODE_VISITS})`);
        expect(result.visitedNodeIds).toHaveLength(FLOW_MAX_NODE_VISITS);
    });
});
