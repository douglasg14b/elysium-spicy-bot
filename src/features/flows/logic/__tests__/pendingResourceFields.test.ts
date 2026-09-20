import { describe, expect, it } from 'vitest';
import { FLOW_GRAPH_VERSION, type FlowGraph } from '../../data/flowGraph';
import { ensureBlocksDiscovered, listBlockDefinitions } from '../../blocks/registry';
import { validateNodeData } from '../../engine/nodeDataValidation';
import { pendingResourceFields } from '../pendingResourceFields';

/**
 * Saving a flow that picked a resource it has not installed.
 *
 * The bug this covers made a whole feature unusable: the picker writes an empty
 * snowflake and a sidecar naming the declaration, and save-time validation only knew
 * that the snowflake had to be non-empty — so choosing anything under "Declared by
 * this flow" produced a flow that could not be saved at all.
 *
 * These go through {@link validateNodeData} rather than asserting the returned set,
 * because the set is a means: what matters is which graphs save.
 */

// Awaited at module scope, not in `beforeAll`: the tables below are built by
// `it.each` while the file is being collected, which happens before any hook runs.
// A `beforeAll` here would generate zero cases and report green over nothing.
await ensureBlocksDiscovered();

const DECLARED = 'qa-channel';

function graphWith(nodes: FlowGraph['nodes']): FlowGraph {
    return { version: FLOW_GRAPH_VERSION, nodes, edges: [] };
}

/** Validate exactly as `validateGraphForSave` does, and return the issues. */
function saveIssues(graph: FlowGraph, declared: readonly string[]) {
    const pending = pendingResourceFields(graph, new Set(declared));
    const nodeData = validateNodeData(graph, { pendingFields: pending.pendingFields });
    return [...pending.issues, ...(nodeData.valid ? [] : nodeData.issues)];
}

/**
 * Every block field a picker can write a resource into, read off the registry.
 *
 * Derived rather than listed, which is the point: the seven that exist today were
 * all broken by the same bug, and an eighth added next month is covered here without
 * anyone remembering to extend a table. A hand-written list would have gone stale on
 * exactly the change it exists to catch.
 */
type PickerCase = [label: string, type: string, fieldKey: string, otherData: Record<string, unknown>];

function pickerFields(): PickerCase[] {
    return listBlockDefinitions().flatMap((block) =>
        block.configFields
            .filter((field) => field.control === 'rolePicker' || field.control === 'channelPicker')
            .map((field): PickerCase => [
                `${block.type}.${field.key}`,
                block.type,
                field.key,
                otherRequiredData(block, field.key),
            ])
    );
}

/**
 * The minimum the block needs beyond the field under test, so nothing else complains.
 *
 * Asked of the **schema** rather than of the field declarations, by parsing and
 * filling in whatever it objects to. Guessing from `control` was the first attempt
 * and was wrong in a way worth recording: `action.postEmbed` declares `url`,
 * `imageUrl` and `thumbnailUrl` as `text`, but their schemas are optional *URLs* —
 * so filling every `text` field with a placeholder made a block fail these tests
 * over three fields that were never required in the first place.
 *
 * Only fields the schema genuinely demands get a value, and each gets one of the
 * right shape. Anything it still objects to after that is a block this helper does
 * not understand, which surfaces as a loud failure rather than a quiet pass.
 */
function otherRequiredData(
    block: ReturnType<typeof listBlockDefinitions>[number],
    skipKey: string
): Record<string, unknown> {
    const data: Record<string, unknown> = {};

    // Bounded: each pass fills at least one key or stops, and a block has finitely
    // many fields. The cap is a guard against a schema that objects to a value this
    // helper just wrote, which would otherwise spin.
    for (let pass = 0; pass <= block.configFields.length; pass += 1) {
        const parsed = block.configSchema.safeParse(data);
        if (parsed.success) break;

        const missing = parsed.error.issues
            .map((issue) => String(issue.path[0] ?? ''))
            .filter((key) => key && key !== skipKey && !(key in data));
        if (missing.length === 0) break;

        for (const key of missing) {
            data[key] = placeholderFor(block.configFields.find((field) => field.key === key)?.control);
        }
    }

    return data;
}

/** A value of the right shape for a required field this test is not exercising. */
function placeholderFor(control: string | undefined): unknown {
    switch (control) {
        case 'rolePicker':
        case 'channelPicker':
            return '123456789012345678';
        case 'duration':
            return 1000;
        default:
            // Every required field on today's pickers is a snowflake or a line of
            // copy. A block whose required field is neither fails loudly here, which
            // is the right outcome: this helper would be guessing.
            return 'x';
    }
}

describe('a picker field left empty because a declared resource fills it', () => {
    it.each(pickerFields())('saves for %s', (_label, type, fieldKey, otherData) => {
        const graph = graphWith([
            {
                id: 'picked',
                type,
                position: { x: 0, y: 0 },
                data: { ...otherData, [fieldKey]: '', [`${fieldKey}Key`]: DECLARED },
            },
        ]);

        expect(saveIssues(graph, [DECLARED])).toEqual([]);
    });

    it.each(pickerFields())(
        'refuses %s when the key is not declared',
        (_label, type, fieldKey, otherData) => {
            const graph = graphWith([
                {
                    id: 'picked',
                    type,
                    position: { x: 0, y: 0 },
                    data: { ...otherData, [fieldKey]: '', [`${fieldKey}Key`]: 'never-declared' },
                },
            ]);

            const issues = saveIssues(graph, [DECLARED]);

            // Exactly one, not two: the schema's "expected >= 1 character" is
            // suppressed so the author reads the mistake rather than its symptom.
            expect(issues).toHaveLength(1);
            expect(issues[0]?.nodeId).toBe('picked');
            expect(issues[0]?.field).toBe(fieldKey);
            // Naming the key is the whole value of this error: "a resource is
            // missing" on a canvas of declarations is not actionable.
            expect(issues[0]?.message).toContain('never-declared');
        }
    );

    it.each(pickerFields())(
        'still refuses %s when it is empty with no sidecar at all',
        (_label, type, fieldKey, otherData) => {
            // The original rule. Relaxing the schemas would have lost this, and an
            // author who picked nothing would have saved a node that cannot run.
            const graph = graphWith([
                { id: 'picked', type, position: { x: 0, y: 0 }, data: { ...otherData, [fieldKey]: '' } },
            ]);

            const issues = saveIssues(graph, [DECLARED]);

            expect(issues).toHaveLength(1);
            expect(issues[0]?.field).toBe(fieldKey);
        }
    );
});

describe('pendingResourceFields', () => {
    it('covers every picker in the registry', () => {
        // The tables above are generated, so an empty registry would report green
        // while testing nothing at all.
        expect(pickerFields().length).toBeGreaterThanOrEqual(7);
    });

    it('leaves an installed field alone even when its key is no longer declared', () => {
        // Install writes the snowflake and deliberately keeps the sidecar, so tidying
        // the Resources list afterwards must not make a working flow unsaveable.
        const graph = graphWith([
            {
                id: 'installed',
                type: 'action.assignRole',
                position: { x: 0, y: 0 },
                data: { roleId: '123456789012345678', roleIdKey: 'retired-role' },
            },
        ]);

        expect(saveIssues(graph, [])).toEqual([]);
    });

    it('scopes a pending field to its own node', () => {
        // Two nodes of the same type, one of which picked a declaration. The other
        // must not inherit permission to be empty.
        const graph = graphWith([
            {
                id: 'picked',
                type: 'action.assignRole',
                position: { x: 0, y: 0 },
                data: { roleId: '', roleIdKey: DECLARED },
            },
            {
                id: 'blank',
                type: 'action.assignRole',
                position: { x: 200, y: 0 },
                data: { roleId: '' },
            },
        ]);

        const issues = saveIssues(graph, [DECLARED]);

        expect(issues).toHaveLength(1);
        expect(issues[0]?.nodeId).toBe('blank');
    });
});
