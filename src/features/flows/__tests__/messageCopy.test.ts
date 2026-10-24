import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Client } from 'discord.js';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { BlockManifest } from '../blocks/manifest';
import { ensureBlocksDiscovered } from '../blocks/registry';
import type { FlowRunSeed } from '../blocks/types';
import { FLOW_GRAPH_VERSION, type FlowGraph, type FlowNode } from '../data/flowGraph';
import { executeFlow } from '../engine/executor';
import { authoredGraphIssues } from '../engine/graphValidation';
import { FIXTURE_ACTION_POSTS_MESSAGE } from './fixtures/blocks/message/actionPostsMessage';
import { FIXTURE_TRIGGER_SUPPLIES_NOBODY } from './fixtures/blocks/subjectAbsent/triggerSuppliesNobody';
import { sentCopy } from './support/sentCopy';

/**
 * The copy walk reaches inside a `message` field: a token deep in an embed counts at save
 * and is filled in at run, through the same walk (`copyLocationsOf`) as a plain copy field.
 *
 * Driven through a test-only block holding one message, the real validator and the real
 * executor — the two readers the walk exists to keep in agreement.
 */

const FIXTURE_ROOTS = ['message', 'subjectAbsent'].map((folder) =>
    join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'blocks', folder)
);

vi.mock('../blocks/registry', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../blocks/registry')>();
    const extra = new Map<string, BlockManifest>();

    return {
        ...actual,
        ensureBlocksDiscovered: async () => {
            await actual.ensureBlocksDiscovered();
            if (extra.size > 0) return;
            for (const root of FIXTURE_ROOTS) {
                for (const [type, definition] of await actual.discoverBlocks<BlockManifest>(root)) {
                    extra.set(type, definition);
                }
            }
        },
        getBlockDefinition: (type: string) => extra.get(type) ?? actual.getBlockDefinition(type),
    };
});

beforeAll(ensureBlocksDiscovered);

const CHANNEL_ID = 'channel-1';

function node(id: string, type: string, data: Record<string, unknown> = {}): FlowNode {
    return { id, type, position: { x: 0, y: 0 }, data };
}

function graphFrom(trigger: FlowNode, target: FlowNode): FlowGraph {
    return {
        version: FLOW_GRAPH_VERSION,
        nodes: [trigger, target],
        edges: [{ id: 'e1', source: trigger.id, target: target.id }],
    };
}

/** A two-embed message whose second embed's first field mentions the member. */
function messageMentioningThem(): Record<string, unknown> {
    return {
        message: {
            content: 'Roll call, {{guild.name}}',
            embeds: [
                { title: 'House Rules', fields: [] },
                {
                    title: 'Who showed up',
                    fields: [{ name: 'Present', value: 'Hey {{subject.mention}}', inline: false }],
                },
            ],
        },
    };
}

describe('a token inside a message', () => {
    it('is refused at save under a trigger about nobody, naming the part it sits in', () => {
        const graph = graphFrom(
            node('trigger', FIXTURE_TRIGGER_SUPPLIES_NOBODY),
            node('target', FIXTURE_ACTION_POSTS_MESSAGE, messageMentioningThem())
        );

        const subjectIssues = authoredGraphIssues(graph).filter(
            (issue) => issue.nodeId === 'target' && /needs "subject" from the run/.test(issue.message)
        );

        expect(subjectIssues).toHaveLength(1);
        expect(subjectIssues[0]?.message).toMatch(
            /for \{\{subject\.mention\}\} in "Message" embed 2 field 1 text, but it can be reached from a trigger whose runs are about nobody/
        );
    });

    it('is refused at save by name when it is not a token a flow can fill in', () => {
        const data = { message: { embeds: [{ title: 'Hi', footer: { text: 'Love, {{subject.shoeSize}}' } }] } };
        const graph = graphFrom(node('trigger', 'trigger.memberJoin'), node('target', FIXTURE_ACTION_POSTS_MESSAGE, data));

        expect(authoredGraphIssues(graph).map((issue) => issue.message).join('\n')).toMatch(
            /has "Message" embed 1 footer containing \{\{subject\.shoeSize\}\}, which is not something a flow can fill in/
        );
    });

    it('is filled in by the executor before the block runs, leaving the stored node as it was', async () => {
        const send = vi.fn().mockResolvedValue({ id: 'message-1' });
        const data = messageMentioningThem();
        const stored = structuredClone(data);
        const graph = graphFrom(node('trigger', 'trigger.memberJoin'), node('target', FIXTURE_ACTION_POSTS_MESSAGE, data));
        const seed = {
            client: {} as Client,
            guild: { id: 'guild-1', name: 'The Dungeon' } as unknown as FlowRunSeed['guild'],
            subject: { id: 'user-1', toString: () => '<@user-1>' } as unknown as FlowRunSeed['subject'],
            channel: { id: CHANNEL_ID, send } as unknown as FlowRunSeed['channel'],
            variables: {},
        } satisfies FlowRunSeed;

        const result = await executeFlow('flow-1', graph, 'trigger', seed);

        expect(result.error).toBeUndefined();
        expect(sentCopy(send)).toEqual(['Hey <@user-1>']);
        expect(data).toEqual(stored);
    });
});
