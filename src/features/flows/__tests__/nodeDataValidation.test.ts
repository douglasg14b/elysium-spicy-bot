import { describe, expect, it } from 'vitest';
import { FLOW_GRAPH_VERSION, type FlowGraph } from '../data/flowGraph';
import { validateNodeData } from '../engine/nodeDataValidation';
import { ACTION_ASSIGN_ROLE } from '../nodes/actionAssignRole';
import { ACTION_POST_EMBED } from '../nodes/actionPostEmbed';
import { TRIGGER_BUTTON_CLICK } from '../nodes/triggerButtonClick';

function graphWith(nodes: FlowGraph['nodes']): FlowGraph {
    return { version: FLOW_GRAPH_VERSION, nodes, edges: [] };
}

describe('validateNodeData', () => {
    it('accepts a graph whose node data matches each configSchema', () => {
        const graph = graphWith([
            { id: 'trigger', type: TRIGGER_BUTTON_CLICK, position: { x: 0, y: 0 }, data: { label: 'Go' } },
            { id: 'assign', type: ACTION_ASSIGN_ROLE, position: { x: 200, y: 0 }, data: { roleId: 'role-1' } },
        ]);

        expect(validateNodeData(graph)).toEqual({ valid: true });
    });

    it('rejects a node whose data fails its configSchema, naming the node id and field', () => {
        const graph = graphWith([
            // roleId is required and must be non-empty.
            { id: 'bad-assign', type: ACTION_ASSIGN_ROLE, position: { x: 0, y: 0 }, data: { roleId: '' } },
        ]);

        const result = validateNodeData(graph);

        expect(result.valid).toBe(false);
        if (!result.valid) {
            expect(result.errors).toHaveLength(1);
            expect(result.errors[0]).toContain('bad-assign');
            expect(result.errors[0]).toContain('roleId');
        }
    });

    it('rejects an unknown node type', () => {
        const graph = graphWith([
            { id: 'mystery', type: 'action.doesNotExist', position: { x: 0, y: 0 }, data: {} },
        ]);

        const result = validateNodeData(graph);

        expect(result.valid).toBe(false);
        if (!result.valid) {
            expect(result.errors[0]).toContain('mystery');
            expect(result.errors[0]).toContain('unknown node type');
        }
    });

    it('reports every offending node, not just the first', () => {
        const graph = graphWith([
            { id: 'bad-1', type: ACTION_ASSIGN_ROLE, position: { x: 0, y: 0 }, data: {} },
            { id: 'bad-2', type: 'nope.nope', position: { x: 100, y: 0 }, data: {} },
        ]);

        const result = validateNodeData(graph);

        expect(result.valid).toBe(false);
        if (!result.valid) {
            expect(result.errors.some((e) => e.startsWith('bad-1:'))).toBe(true);
            expect(result.errors.some((e) => e.startsWith('bad-2:'))).toBe(true);
        }
    });

    it('rejects a postEmbed colour that is not a hex value', () => {
        const graph = graphWith([
            {
                id: 'embed',
                type: ACTION_POST_EMBED,
                position: { x: 0, y: 0 },
                data: { channelId: 'chan-1', title: 'Hi', description: 'There', color: 'cyan' },
            },
        ]);

        const result = validateNodeData(graph);

        expect(result.valid).toBe(false);
        if (!result.valid) {
            expect(result.errors[0]).toContain('embed');
            expect(result.errors[0]).toContain('hex');
        }
    });
});
