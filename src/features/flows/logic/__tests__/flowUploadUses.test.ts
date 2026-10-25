import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { migrateTestDatabase } from '../../../../features-system/data-persistence/__tests__/support/migrateTestDatabase';
import { ACTION_POST_EMBED } from '../../blocks/actionPostEmbed';
import type { BlockManifest } from '../../blocks/manifest';
import { ensureBlocksDiscovered } from '../../blocks/registry';
import { flowDraftsRepo } from '../../data/flowDraftsRepo';
import { FLOW_GRAPH_VERSION, type FlowGraph } from '../../data/flowGraph';
import { flowsRepo } from '../../data/flowsRepo';
import { FIXTURE_ACTION_POSTS_MESSAGE } from '../../__tests__/fixtures/blocks/message/actionPostsMessage';
import { FIXTURE_ACTION_SOMETIMES_POSTS_MESSAGE } from '../../__tests__/fixtures/blocks/message/actionSometimesPostsMessage';
import { flowUploadUses } from '../flowUploadUses';

/**
 * Flows' upload usage reader, against the real flows and drafts repos on the migrated schema:
 * every place a saved flow or a draft of this guild shows an upload, found by the `message`
 * control rather than by Post Embed's type.
 */

const FIXTURE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '__tests__', 'fixtures', 'blocks', 'message');

vi.mock('../../blocks/registry', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../blocks/registry')>();
    let extra: ReadonlyMap<string, BlockManifest> | undefined;

    return {
        ...actual,
        ensureBlocksDiscovered: async () => {
            await actual.ensureBlocksDiscovered();
            extra ??= await actual.discoverBlocks<BlockManifest>(FIXTURE_ROOT);
        },
        getBlockDefinition: (type: string) => extra?.get(type) ?? actual.getBlockDefinition(type),
    };
});

beforeAll(async () => {
    await ensureBlocksDiscovered();
    await migrateTestDatabase();
});

/** One node of `type` holding `message` in its `message` field. */
function holding(type: string, message: Record<string, unknown>, nodeId = 'post'): FlowGraph {
    return {
        version: FLOW_GRAPH_VERSION,
        nodes: [{ id: nodeId, type, position: { x: 0, y: 0 }, data: { channelId: '1', message } }],
        edges: [],
    };
}

const ref = (uploadId: string): string => `upload:${uploadId}`;

describe('flowUploadUses', () => {
    it('finds every upload a saved flow shows, in any embed and any picture part, one use per place', async () => {
        const guildId = 'guild-saved';
        const [header, thumbnail, footer] = [randomUUID(), randomUUID(), randomUUID()];
        const flow = await flowsRepo.create({
            guildId,
            name: 'Welcome flow',
            graph: holding(ACTION_POST_EMBED, {
                embeds: [
                    { title: 'First', thumbnail: ref(thumbnail), image: 'https://example.com/linked.png' },
                    {
                        title: 'Second',
                        author: { name: 'Mistress', iconUrl: ref(header) },
                        footer: { text: 'Bye', iconUrl: ref(footer) },
                        image: ref(thumbnail),
                    },
                ],
            }),
        });

        const uses = await flowUploadUses(guildId);

        const saved = { kind: 'flow', flowId: flow.flowId, flowName: 'Welcome flow', nodeId: 'post', blockLabel: 'Post Embed' };
        expect(uses).toEqual([
            { ...saved, uploadId: thumbnail, where: 'embed 1 thumbnail' },
            { ...saved, uploadId: header, where: 'embed 2 header icon' },
            { ...saved, uploadId: thumbnail, where: 'embed 2 image' },
            { ...saved, uploadId: footer, where: 'embed 2 footer icon' },
        ]);
    });

    it("finds an upload only a draft shows, marked with the draft's author and named as the draft has it", async () => {
        const guildId = 'guild-draft';
        const uploadId = randomUUID();
        const flow = await flowsRepo.create({
            guildId,
            name: 'Saved name',
            graph: holding(ACTION_POST_EMBED, { embeds: [{ title: 'Nothing uploaded' }] }),
        });
        await flowDraftsRepo.upsertMine({
            flowId: flow.flowId,
            guildId,
            authorId: 'author-1',
            authorName: 'brat',
            name: 'Renamed in the draft',
            graph: holding(ACTION_POST_EMBED, { embeds: [{ title: 'Pictured', image: ref(uploadId) }] }),
            baseUpdatedAt: new Date().toISOString(),
        });

        expect(await flowUploadUses(guildId)).toEqual([
            {
                kind: 'flow',
                uploadId,
                flowId: flow.flowId,
                flowName: 'Renamed in the draft',
                nodeId: 'post',
                blockLabel: 'Post Embed',
                where: 'embed 1 image',
                draftAuthorId: 'author-1',
            },
        ]);
    });

    it('finds the message field by its control, whatever block holds it', async () => {
        const guildId = 'guild-fixture';
        const uploadId = randomUUID();
        const flow = await flowsRepo.create({
            guildId,
            name: 'Fixture flow',
            graph: holding(FIXTURE_ACTION_POSTS_MESSAGE, { embeds: [{ title: 'Held', thumbnail: ref(uploadId) }] }, 'fixture'),
        });

        expect(await flowUploadUses(guildId)).toEqual([
            {
                kind: 'flow',
                uploadId,
                flowId: flow.flowId,
                flowName: 'Fixture flow',
                nodeId: 'fixture',
                blockLabel: 'Posts Message',
                where: 'embed 1 thumbnail',
            },
        ]);
    });

    it('counts a picture a hidden message field still holds', async () => {
        const guildId = 'guild-hidden';
        const uploadId = randomUUID();
        const graph: FlowGraph = {
            version: FLOW_GRAPH_VERSION,
            nodes: [
                {
                    id: 'quiet',
                    type: FIXTURE_ACTION_SOMETIMES_POSTS_MESSAGE,
                    position: { x: 0, y: 0 },
                    data: { mode: 'quiet', message: { embeds: [{ title: 'Hidden', image: ref(uploadId) }] } },
                },
            ],
            edges: [],
        };
        const flow = await flowsRepo.create({ guildId, name: 'Hidden flow', graph });

        expect(await flowUploadUses(guildId)).toEqual([
            {
                kind: 'flow',
                uploadId,
                flowId: flow.flowId,
                flowName: 'Hidden flow',
                nodeId: 'quiet',
                blockLabel: 'Sometimes Posts',
                where: 'embed 1 image',
            },
        ]);
    });

    it('lists a draft use only where the saved flow does not already show the picture', async () => {
        const guildId = 'guild-draft-same-flow';
        const [shared, draftOnly] = [randomUUID(), randomUUID()];
        const flow = await flowsRepo.create({
            guildId,
            name: 'Both',
            graph: holding(ACTION_POST_EMBED, { embeds: [{ title: 'Saved', image: ref(shared) }] }),
        });
        await flowDraftsRepo.upsertMine({
            flowId: flow.flowId,
            guildId,
            authorId: 'author-2',
            authorName: 'switch',
            name: 'Both',
            graph: holding(ACTION_POST_EMBED, { embeds: [{ title: 'Drafted', image: ref(shared), thumbnail: ref(draftOnly) }] }),
            baseUpdatedAt: new Date().toISOString(),
        });

        const at = { kind: 'flow', flowId: flow.flowId, flowName: 'Both', nodeId: 'post', blockLabel: 'Post Embed' };
        expect(await flowUploadUses(guildId)).toEqual([
            { ...at, uploadId: shared, where: 'embed 1 image' },
            { ...at, uploadId: draftOnly, where: 'embed 1 thumbnail', draftAuthorId: 'author-2' },
        ]);
    });

    it("skips a node whose block is gone, and never reads another guild's flows", async () => {
        const guildId = 'guild-quiet';
        await flowsRepo.create({
            guildId,
            name: 'Removed block',
            graph: holding('action.removedLongAgo', { embeds: [{ title: 'Gone', image: ref(randomUUID()) }] }),
        });
        await flowsRepo.create({
            guildId: 'guild-quiet-neighbour',
            name: 'Not ours',
            graph: holding(ACTION_POST_EMBED, { embeds: [{ title: 'Theirs', image: ref(randomUUID()) }] }),
        });

        expect(await flowUploadUses(guildId)).toEqual([]);
    });
});
