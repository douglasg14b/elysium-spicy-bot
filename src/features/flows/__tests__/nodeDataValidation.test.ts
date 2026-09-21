import { beforeAll, describe, expect, it } from 'vitest';
import { FLOW_GRAPH_VERSION, type FlowGraph } from '../data/flowGraph';
import { describeIssue, validateNodeData } from '../engine/nodeDataValidation';
import { ensureBlocksDiscovered } from '../blocks/registry';
import { ACTION_ASSIGN_ROLE } from '../blocks/actionAssignRole';
import { ACTION_POST_EMBED } from '../blocks/actionPostEmbed';
import { TRIGGER_BUTTON_CLICK } from '../blocks/triggerButtonClick';

function graphWith(nodes: FlowGraph['nodes']): FlowGraph {
    return { version: FLOW_GRAPH_VERSION, nodes, edges: [] };
}

/** `pendingFields` for one node, in the nested shape the validator takes. */
function pending(nodeId: string, ...fields: string[]): ReadonlyMap<string, ReadonlySet<string>> {
    return new Map([[nodeId, new Set(fields)]]);
}

/** Every issue rendered the way a single-sentence client would show it. */
function sentences(
    graph: FlowGraph,
    pendingFields?: ReadonlyMap<string, ReadonlySet<string>>
): string[] {
    const result = validateNodeData(graph, pendingFields ? { pendingFields } : {});
    return result.valid ? [] : result.issues.map(describeIssue);
}

// Validation reads the registry, which is populated by scanning the blocks tree.
beforeAll(ensureBlocksDiscovered);

describe('validateNodeData', () => {
    it('accepts a graph whose node data matches each configSchema', () => {
        const graph = graphWith([
            { id: 'trigger', type: TRIGGER_BUTTON_CLICK, position: { x: 0, y: 0 }, data: { channelId: 'channel-1', label: 'Go' } },
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
            expect(result.issues).toHaveLength(1);
            expect(result.issues[0]?.nodeId).toBe('bad-assign');
            expect(result.issues[0]?.field).toBe('roleId');
        }
    });

    it('rejects an unknown node type', () => {
        const graph = graphWith([
            { id: 'mystery', type: 'action.doesNotExist', position: { x: 0, y: 0 }, data: {} },
        ]);

        const result = validateNodeData(graph);

        expect(result.valid).toBe(false);
        if (!result.valid) {
            // No field to blame — the whole node is the problem.
            expect(result.issues[0]).toEqual({
                nodeId: 'mystery',
                message: 'unknown node type "action.doesNotExist"',
            });
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
            expect(result.issues.map((issue) => issue.nodeId)).toEqual(['bad-1', 'bad-2']);
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
            expect(result.issues[0]?.nodeId).toBe('embed');
            expect(result.issues[0]?.field).toBe('color');
            expect(result.issues[0]?.message).toContain('hex');
        }
    });

    /**
     * A field path that is not a bare key. The builder puts an issue under the
     * control that caused it, and an embed field's name is not a control of its
     * own — so losing the index would put "too long" under the wrong row.
     */
    it('carries the dotted path for a nested field', () => {
        const graph = graphWith([
            {
                id: 'embed',
                type: ACTION_POST_EMBED,
                position: { x: 0, y: 0 },
                data: {
                    channelId: 'chan-1',
                    title: 'Hi',
                    description: 'There',
                    fields: [
                        { name: 'ok', value: 'fine' },
                        { name: '', value: 'fine' },
                    ],
                },
            },
        ]);

        const result = validateNodeData(graph);

        expect(result.valid).toBe(false);
        if (!result.valid) {
            expect(result.issues[0]?.field).toBe('fields.1.name');
            expect(describeIssue(result.issues[0]!)).toContain('embed: fields.1.name:');
        }
    });
});

/**
 * Fields something else fills in later.
 *
 * The exemption is deliberately narrow — *empty is allowed, wrong is not* — because
 * it is the only thing standing between "this value arrives at install" and "this
 * node can save with anything in it".
 */
describe('validateNodeData with pending fields', () => {
    const emptyRole = graphWith([
        { id: 'assign', type: ACTION_ASSIGN_ROLE, position: { x: 0, y: 0 }, data: { roleId: '' } },
    ]);

    it('accepts an empty value for a field named as pending', () => {
        expect(validateNodeData(emptyRole, { pendingFields: pending('assign', 'roleId') })).toEqual({
            valid: true,
        });
    });

    it('accepts an absent value for a field named as pending', () => {
        const graph = graphWith([
            { id: 'assign', type: ACTION_ASSIGN_ROLE, position: { x: 0, y: 0 }, data: {} },
        ]);

        expect(validateNodeData(graph, { pendingFields: pending('assign', 'roleId') })).toEqual({
            valid: true,
        });
    });

    it('still rejects the same empty value when nothing vouches for it', () => {
        expect(sentences(emptyRole)).toHaveLength(1);
    });

    it('does not let a pending field name excuse a different node', () => {
        // Node-scoped, so one node picking a declared resource cannot quietly
        // authorise an empty field on every other node of the same type.
        expect(sentences(emptyRole, pending('some-other-node', 'roleId'))).toHaveLength(1);
    });

    it('still rejects a wrongly-typed value on a pending field', () => {
        // "Filled in later" says when the value arrives, not that any value will do.
        const graph = graphWith([
            { id: 'assign', type: ACTION_ASSIGN_ROLE, position: { x: 0, y: 0 }, data: { roleId: 42 } },
        ]);

        expect(sentences(graph, pending('assign', 'roleId'))).toHaveLength(1);
    });

    /**
     * A node id is free-form — `flowGraph.ts` asks only for a non-empty string — so
     * it can contain a dot, and a nested config path contains dots too.
     *
     * While `pendingFields` was a flat set of `"<nodeId>.<field>"` strings, those two
     * met: a node called `embed.fields.0` with a pending `name` spelled the *same*
     * key as node `embed` with a pending `fields.0.name`, and one node's declaration
     * silently suppressed a genuine issue on another. Nesting the map by node id
     * leaves no separator to collide on, and this is the graph that proves it.
     */
    it("does not let one node id spell another node's dotted field path", () => {
        const graph = graphWith([
            {
                id: 'embed',
                type: ACTION_POST_EMBED,
                position: { x: 0, y: 0 },
                // `fields.0.name` is missing, which is a genuine issue.
                data: {
                    channelId: 'chan-1',
                    title: 'Hi',
                    description: 'There',
                    fields: [{ value: 'v' }],
                },
            },
            {
                id: 'embed.fields.0',
                type: ACTION_ASSIGN_ROLE,
                position: { x: 200, y: 0 },
                data: { roleId: 'role-1' },
            },
        ]);

        const result = validateNodeData(graph, { pendingFields: pending('embed.fields.0', 'name') });

        expect(result.valid).toBe(false);
        if (!result.valid) {
            expect(result.issues[0]?.nodeId).toBe('embed');
            expect(result.issues[0]?.field).toBe('fields.0.name');
        }
    });

    it('never treats a nested path as pending, whatever is named', () => {
        /*
         * Only a top-level config key can be filled in later, and the check is on the
         * path's *length* rather than on the joined string for a reason this case
         * shows: `data['fields.0.name']` is `undefined` whatever the entry actually
         * holds, so a lookup by joined path takes the "value is absent" branch every
         * time — never reading the value the branch exists to judge.
         *
         * The entry here is missing `name` outright, which Zod reports as
         * `invalid_type`. That is precisely the code the absent branch forgives, so
         * without the length guard this graph saves clean with an embed field that
         * has no name.
         */
        const graph = graphWith([
            {
                id: 'embed',
                type: ACTION_POST_EMBED,
                position: { x: 0, y: 0 },
                data: {
                    channelId: 'chan-1',
                    title: 'Hi',
                    description: 'There',
                    fields: [{ value: 'v' }],
                },
            },
        ]);

        expect(sentences(graph, pending('embed', 'fields.0.name'))).toHaveLength(1);
    });

    it('still rejects a non-emptiness rule on a pending field', () => {
        // A colour that is present and malformed is wrong now, not pending.
        const graph = graphWith([
            {
                id: 'embed',
                type: ACTION_POST_EMBED,
                position: { x: 0, y: 0 },
                data: { channelId: '', title: 'Hi', description: 'There', color: 'cyan' },
            },
        ]);

        const result = validateNodeData(graph, {
            pendingFields: pending('embed', 'channelId', 'color'),
        });

        expect(result.valid).toBe(false);
        if (!result.valid) {
            expect(result.issues).toHaveLength(1);
            expect(result.issues[0]?.field).toBe('color');
        }
    });
});
