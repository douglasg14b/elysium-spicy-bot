import { beforeAll, describe, expect, it } from 'vitest';
import { ACTION_POST_EMBED } from '../../blocks/actionPostEmbed';
import { ensureBlocksDiscovered } from '../../blocks/registry';
import { FLOW_GRAPH_VERSION, type FlowGraph } from '../../data/flowGraph';
import { withDeclaredNodeData } from '../declaredNodeData';

/**
 * What a save keeps of a node's data: the keys its block declares — each field, a picker's
 * `<field>Key`, and the key a `message` field keeps its buttons in — and nothing else.
 */

beforeAll(async () => {
    await ensureBlocksDiscovered();
});

function postEmbed(data: Record<string, unknown>): FlowGraph {
    return {
        version: FLOW_GRAPH_VERSION,
        nodes: [{ id: 'post', type: ACTION_POST_EMBED, position: { x: 0, y: 0 }, data }],
        edges: [],
    };
}

describe('the keys a save keeps', () => {
    it("keeps a message's buttons, in the key its field names, and drops a key nothing declares", () => {
        const buttons = [{ key: 'safeword', label: 'Red', style: 'Danger' }];
        const saved = withDeclaredNodeData(
            postEmbed({ channelId: '123456789012345678', message: { embeds: [{ title: 'Rules' }] }, buttons, title: 'old' })
        );

        expect(saved.nodes[0]?.data).toEqual({
            channelId: '123456789012345678',
            message: { embeds: [{ title: 'Rules' }] },
            buttons,
        });
    });
});
