import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { guildUploadsRepo } from '../../../../features-system/guild-uploads';
import { migrateTestDatabase } from '../../../../features-system/data-persistence/__tests__/support/migrateTestDatabase';
import { MIB } from '../../../../shared/byteSizes';
import { ACTION_POST_EMBED } from '../../blocks/actionPostEmbed';
import { ensureBlocksDiscovered } from '../../blocks/registry';
import { FLOW_GRAPH_VERSION, type FlowGraph } from '../../data/flowGraph';
import { loadUploadIndex, uploadIndexCovers, uploadReferenceIssues } from '../uploadReferences';

/**
 * The upload half of readiness, against the real uploads repo on the migrated schema: what a
 * graph's messages show must be this server's, and fit in one message.
 */

const GUILD_ID = 'guild-home';
const OTHER_GUILD_ID = 'guild-elsewhere';
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

async function upload(guildId: string, size = 64): Promise<string> {
    const bytes = Buffer.concat([PNG_SIGNATURE, randomBytes(size - PNG_SIGNATURE.length)]);
    const { upload: stored } = await guildUploadsRepo.create({
        guildId,
        fileName: 'leash.png',
        contentType: 'image/png',
        sha256: createHash('sha256').update(bytes).digest('hex'),
        bytes,
        uploadedBy: 'operator-1',
    });
    return stored.uploadId;
}

/** One Post Embed node holding `message`. */
function posting(message: Record<string, unknown>): FlowGraph {
    return {
        version: FLOW_GRAPH_VERSION,
        nodes: [{ id: 'post', type: ACTION_POST_EMBED, position: { x: 0, y: 0 }, data: { channelId: '1', message } }],
        edges: [],
    };
}

beforeAll(async () => {
    await ensureBlocksDiscovered();
    await migrateTestDatabase();
});

afterEach(() => {
    vi.restoreAllMocks();
});

describe('loadUploadIndex', () => {
    it('asks nothing of the database when no graph names an upload', async () => {
        const sizesFor = vi.spyOn(guildUploadsRepo, 'sizesFor');

        const index = await loadUploadIndex(GUILD_ID, [
            posting({ embeds: [{ title: 'Linked', image: 'https://example.com/a.png' }] }),
        ]);

        expect(sizesFor).not.toHaveBeenCalled();
        expect(index.named.size).toBe(0);
    });

    it('holds the sizes of only those named uploads this server has', async () => {
        const ours = await upload(GUILD_ID);
        const theirs = await upload(OTHER_GUILD_ID);

        const index = await loadUploadIndex(GUILD_ID, [
            posting({ embeds: [{ title: 'Two', thumbnail: `upload:${ours}`, image: `upload:${theirs}` }] }),
        ]);

        expect([...index.named].sort()).toEqual([ours, theirs].sort());
        expect([...index.sizes.keys()]).toEqual([ours]);
    });
});

describe('uploadReferenceIssues', () => {
    it("addresses another server's upload to the part showing it", async () => {
        const theirs = await upload(OTHER_GUILD_ID);
        const graph = posting({
            embeds: [
                { title: 'Fine' },
                { title: 'Borrowed', author: { name: 'Them', iconUrl: `upload:${theirs}` }, image: `upload:${theirs}` },
            ],
        });

        const issues = uploadReferenceIssues(graph, await loadUploadIndex(GUILD_ID, [graph]));

        expect(issues).toEqual([
            { nodeId: 'post', field: 'message.embeds.1.author.iconUrl', message: expect.stringMatching(/isn't in this server/) },
            { nodeId: 'post', field: 'message.embeds.1.image', message: expect.stringMatching(/isn't in this server/) },
        ]);
    });

    it('says nothing of uploads this server holds', async () => {
        const ours = await upload(GUILD_ID);
        const graph = posting({ embeds: [{ title: 'Ours', thumbnail: `upload:${ours}` }] });

        expect(uploadReferenceIssues(graph, await loadUploadIndex(GUILD_ID, [graph]))).toEqual([]);
    });

    it('addresses a message whose uploads together are over the cap to the message, counting a repeat once', async () => {
        const first = await upload(GUILD_ID, 6 * MIB);
        const second = await upload(GUILD_ID, 5 * MIB);
        const underCap = posting({ embeds: [{ title: 'Once', thumbnail: `upload:${first}`, image: `upload:${first}` }] });
        const overCap = posting({ embeds: [{ title: 'Both', thumbnail: `upload:${first}`, image: `upload:${second}` }] });
        const index = await loadUploadIndex(GUILD_ID, [underCap, overCap]);

        expect(uploadReferenceIssues(underCap, index)).toEqual([]);
        expect(uploadReferenceIssues(overCap, index)).toEqual([
            { nodeId: 'post', field: 'message', message: expect.stringMatching(/come to 11\.0 MB, and Discord takes 10 MB/) },
        ]);
    });

    it('addresses a message showing more uploads than Discord attaches to the message, counting a repeat once', async () => {
        const uploadIds = await Promise.all(Array.from({ length: 11 }, () => upload(GUILD_ID)));
        /** Ten embeds, each showing its own one of the first ten uploads, the first also showing `thumbnail`. */
        const tenEmbedsWithThumbnail = (thumbnail: string) => {
            const embeds: Record<string, unknown>[] = uploadIds
                .slice(0, 10)
                .map((uploadId, index) => ({ title: `Exhibit ${index + 1}`, image: `upload:${uploadId}` }));
            return posting({ embeds: [{ ...embeds[0], thumbnail: `upload:${thumbnail}` }, ...embeds.slice(1)] });
        };
        // The first upload shown twice is still ten files; an eleventh upload is not.
        const ten = tenEmbedsWithThumbnail(uploadIds[0] ?? '');
        const eleven = tenEmbedsWithThumbnail(uploadIds[10] ?? '');
        const index = await loadUploadIndex(GUILD_ID, [ten, eleven]);

        expect(uploadReferenceIssues(ten, index)).toEqual([]);
        expect(uploadReferenceIssues(eleven, index)).toEqual([
            {
                nodeId: 'post',
                field: 'message',
                message: expect.stringMatching(/shows 11 different uploaded pictures, and Discord takes 10 files a message/),
            },
        ]);
    });

    it('refuses to judge a graph its index was not loaded for', async () => {
        const index = await loadUploadIndex(GUILD_ID, [posting({ embeds: [{ title: 'Nothing uploaded' }] })]);
        const other = posting({ embeds: [{ title: 'New', image: `upload:${randomUUID()}` }] });

        expect(uploadIndexCovers(index, other)).toBe(false);
        expect(() => uploadReferenceIssues(other, index)).toThrow(/was not loaded/);
    });
});
