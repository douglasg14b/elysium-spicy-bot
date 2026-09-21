import { describe, expect, it } from 'vitest';
import type { FlowGraph } from '../data/flowGraph';
import { FLOW_GRAPH_VERSION } from '../data/flowGraph';
import { bindResourcesToGraph } from '../logic/bindResourcesToGraph';

/**
 * Writing provisioned ids into node configs — the concrete half of the "install
 * writes snowflakes in" decision.
 *
 * The property worth testing is that an *unresolved* target is reported rather than
 * quietly skipped. A node silently left without its id produces a block that fails at
 * run time, far from the install that should have populated it.
 */

function graph(): FlowGraph {
    return {
        version: FLOW_GRAPH_VERSION,
        nodes: [
            { id: 'n-trigger', type: 'trigger.buttonClick', position: { x: 0, y: 0 }, data: { channelId: 'channel-1', label: 'Agree' } },
            { id: 'n-role', type: 'action.assignRole', position: { x: 1, y: 0 }, data: { roleId: '' } },
            { id: 'n-dm', type: 'action.sendDM', position: { x: 2, y: 0 }, data: { message: 'hi' } },
        ],
        edges: [],
    } as FlowGraph;
}

describe('bindResourcesToGraph', () => {
    it('writes a resolved id into the named node config key', () => {
        const result = bindResourcesToGraph(
            graph(),
            [{ nodeId: 'n-role', configKey: 'roleId', resourceKey: 'member-role' }],
            new Map([['member-role', 'role-123']])
        );

        const roleNode = result.graph.nodes.find((node) => node.id === 'n-role');
        expect(roleNode?.data.roleId).toBe('role-123');
        expect(result.unresolved).toHaveLength(0);
    });

    it('leaves every other node and key untouched', () => {
        const before = graph();
        const result = bindResourcesToGraph(
            before,
            [{ nodeId: 'n-role', configKey: 'roleId', resourceKey: 'member-role' }],
            new Map([['member-role', 'role-123']])
        );

        expect(result.graph.nodes.find((node) => node.id === 'n-dm')?.data).toEqual({ message: 'hi' });
        expect(result.graph.nodes.find((node) => node.id === 'n-trigger')?.data).toEqual({
            channelId: 'channel-1',
            label: 'Agree',
        });
        // The input graph is not mutated in place.
        expect(before.nodes.find((node) => node.id === 'n-role')?.data.roleId).toBe('');
    });

    it('reports a target whose resource has no live binding', () => {
        // Silently leaving the node empty is the failure this guards: the flow would
        // save, deploy, and then fail on the first press.
        const target = { nodeId: 'n-role', configKey: 'roleId', resourceKey: 'member-role' };
        const result = bindResourcesToGraph(graph(), [target], new Map());

        expect(result.unresolved).toEqual([target]);
        expect(result.graph.nodes.find((node) => node.id === 'n-role')?.data.roleId).toBe('');
    });

    it('reports a target naming a node the graph does not contain', () => {
        const target = { nodeId: 'n-missing', configKey: 'roleId', resourceKey: 'member-role' };
        const result = bindResourcesToGraph(
            graph(),
            [target],
            new Map([['member-role', 'role-123']])
        );

        expect(result.unresolved).toEqual([target]);
    });

    it('writes several keys into one node', () => {
        const result = bindResourcesToGraph(
            graph(),
            [
                { nodeId: 'n-role', configKey: 'roleId', resourceKey: 'member-role' },
                { nodeId: 'n-role', configKey: 'channelId', resourceKey: 'welcome-channel' },
            ],
            new Map([
                ['member-role', 'role-123'],
                ['welcome-channel', 'chan-456'],
            ])
        );

        const roleNode = result.graph.nodes.find((node) => node.id === 'n-role');
        expect(roleNode?.data.roleId).toBe('role-123');
        expect(roleNode?.data.channelId).toBe('chan-456');
    });
});
