import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { FLOW_GRAPH_VERSION, type FlowGraph } from '../../data/flowGraph';
import { RESOURCE_KEY_SUFFIX, collectResourceTargets } from '../resourceTargets';

/**
 * Finding which node configs are waiting on a provisioned id.
 *
 * The pairing is a convention shared with the builder — `roleId` holds the snowflake,
 * `roleIdKey` names the declaration — so these tests are what stop the two halves
 * drifting apart silently. A missed target is a node that keeps an empty id and fails
 * at run time; a spurious one writes a snowflake over a config key that never asked
 * for it.
 */

function graphWith(nodes: { id: string; data: Record<string, unknown> }[]): FlowGraph {
    return {
        version: FLOW_GRAPH_VERSION,
        nodes: nodes.map((node) => ({
            id: node.id,
            type: 'action.assignRole',
            position: { x: 0, y: 0 },
            data: node.data,
        })),
        edges: [],
    };
}

describe('collectResourceTargets', () => {
    it('finds a picked resource and names the field to write into', () => {
        const targets = collectResourceTargets(
            graphWith([{ id: 'node-1', data: { roleId: '', roleIdKey: 'member-role' } }])
        );

        expect(targets).toEqual([
            { nodeId: 'node-1', configKey: 'roleId', resourceKey: 'member-role' },
        ]);
    });

    it('ignores a node that picked a real snowflake', () => {
        // No sidecar means the author picked something that already exists. Writing
        // to it would overwrite a deliberate choice.
        const targets = collectResourceTargets(
            graphWith([{ id: 'node-1', data: { roleId: '123456789012345678' } }])
        );

        expect(targets).toEqual([]);
    });

    it('finds several targets on one node', () => {
        // A block with both a channel and a role picker keeps them apart, which is
        // why the sidecar is derived per field rather than being one shared key.
        const targets = collectResourceTargets(
            graphWith([
                {
                    id: 'node-1',
                    data: {
                        channelId: '',
                        channelIdKey: 'qa-channel',
                        roleId: '',
                        roleIdKey: 'helper-role',
                    },
                },
            ])
        );

        expect(targets).toHaveLength(2);
        expect(targets.map((target) => target.configKey).sort()).toEqual(['channelId', 'roleId']);
    });

    it('ignores an empty resource key', () => {
        // Clearing a picker leaves the sidecar briefly empty. Treating that as a
        // target would look up the empty string and report it as unresolved.
        const targets = collectResourceTargets(
            graphWith([{ id: 'node-1', data: { roleId: '', roleIdKey: '' } }])
        );

        expect(targets).toEqual([]);
    });

    it('ignores a non-string value under a key-shaped config entry', () => {
        const targets = collectResourceTargets(
            graphWith([{ id: 'node-1', data: { countKey: 42 } }])
        );

        expect(targets).toEqual([]);
    });

    it('ignores a bare suffix that names no field', () => {
        // `Key` alone would slice to an empty target field and write into `data['']`,
        // corrupting the node rather than failing.
        const targets = collectResourceTargets(
            graphWith([{ id: 'node-1', data: { [RESOURCE_KEY_SUFFIX]: 'member-role' } }])
        );

        expect(targets).toEqual([]);
    });

    it('collects across every node in the graph', () => {
        const targets = collectResourceTargets(
            graphWith([
                { id: 'node-1', data: { roleId: '', roleIdKey: 'member-role' } },
                { id: 'node-2', data: { channelId: '', channelIdKey: 'qa-channel' } },
            ])
        );

        expect(targets.map((target) => target.nodeId).sort()).toEqual(['node-1', 'node-2']);
    });
});

describe('the suffix contract with the builder', () => {
    it('matches what the web control library actually appends', () => {
        // Read the web source rather than restating the constant. The two packages
        // share no module, so an assertion written from memory would keep passing
        // after someone changed one side — which is precisely the drift that would
        // leave every picked resource silently unresolved.
        const source = readFileSync(
            join(
                dirname(fileURLToPath(import.meta.url)),
                '..','..','..','..','..',
                'web','src','flows','controls','types.ts'
            ),
            'utf8'
        );

        const match = /return `\$\{fieldKey\}([A-Za-z]+)`/.exec(source);
        if (!match) {
            throw new Error(
                'Could not find `resourceKeyFieldFor` in the web control library. If it moved, update this test — the contract it guards is still real.'
            );
        }

        expect(match[1]).toBe(RESOURCE_KEY_SUFFIX);
    });
});
