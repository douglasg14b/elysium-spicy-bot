import { createHash, randomBytes } from 'node:crypto';
import { Hono } from 'hono';
import { beforeAll, describe, expect, it } from 'vitest';
import { ensureBlocksDiscovered } from '../../../features/flows/blocks/registry';
import { FLOW_GRAPH_VERSION, type FlowGraph } from '../../../features/flows/data/flowGraph';
import { fakeGuild } from '../../../features/flows/__tests__/support/fakeGuild';
import { guildUploadsRepo } from '../../../features-system/guild-uploads';
import { migrateTestDatabase } from '../../../features-system/data-persistence/__tests__/support/migrateTestDatabase';
import type { AppEnv } from '../../types';
import { flowRoutes } from '../flowRoutes';

/**
 * An uploaded picture is part of a flow's readiness: one this server does not hold is an
 * issue on the part showing it, so the flow saves as unfinished and cannot be switched on —
 * through the real routes, the real repos and an in-memory sqlite built by the migrations.
 */

const GUILD_ID = 'guild-home';
const OTHER_GUILD_ID = 'guild-elsewhere';
const CHANNEL_ID = '111111111111111111';
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

interface Issue {
    readonly nodeId?: string;
    readonly field?: string;
    readonly message: string;
}

async function upload(guildId: string): Promise<string> {
    const bytes = Buffer.concat([PNG_SIGNATURE, randomBytes(32)]);
    const { upload: stored } = await guildUploadsRepo.create({
        guildId,
        fileName: 'whip.png',
        contentType: 'image/png',
        sha256: createHash('sha256').update(bytes).digest('hex'),
        bytes,
        uploadedBy: 'operator-1',
    });
    return stored.uploadId;
}

/** Post Embed into the guild's one channel, its image the given upload. */
function postingUpload(uploadId: string): FlowGraph {
    return {
        version: FLOW_GRAPH_VERSION,
        nodes: [
            {
                id: 'post',
                type: 'action.postEmbed',
                position: { x: 0, y: 0 },
                data: { channelId: CHANNEL_ID, message: { embeds: [{ title: 'Exhibit A', image: `upload:${uploadId}` }] } },
            },
        ],
        edges: [],
    };
}

async function send<T>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> {
    const app = new Hono<AppEnv>();
    app.use('*', async (c, next) => {
        c.set('guild', fakeGuild({ id: GUILD_ID, channels: { [CHANNEL_ID]: {} } }));
        c.set('user', { id: 'operator-1', username: 'operator', avatar: null, manageableGuildIds: [GUILD_ID] });
        await next();
    });
    app.route('/', flowRoutes());
    const response = await app.request(`/${GUILD_ID}${path}`, {
        method,
        headers: body === undefined ? undefined : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: (await response.json()) as T };
}

async function createFlow(graph: FlowGraph): Promise<{ flowId: string; issues: Issue[] }> {
    const created = await send<{ flowId: string; issues: Issue[] }>('POST', '/flows', { name: 'Show and tell', graph });
    expect(created.status).toBe(201);
    return created.body;
}

beforeAll(async () => {
    await ensureBlocksDiscovered();
    await migrateTestDatabase();
});

describe("a graph showing another server's upload", () => {
    const NOT_HERE: Issue = {
        nodeId: 'post',
        field: 'message.embeds.0.image',
        message: expect.stringMatching(/That uploaded picture isn't in this server/),
    };

    it('saves as unfinished, with the issue on the part', async () => {
        const created = await createFlow(postingUpload(await upload(OTHER_GUILD_ID)));

        expect(created.issues).toEqual([NOT_HERE]);
    });

    it('cannot be switched on', async () => {
        const { flowId } = await createFlow(postingUpload(await upload(OTHER_GUILD_ID)));

        const refused = await send<{ error: string; issues: Issue[] }>('PUT', `/flows/${flowId}`, { enabled: true });

        expect(refused.status).toBe(400);
        expect(refused.body).toEqual({ error: 'Fix 1 problem before turning this flow on.', issues: [NOT_HERE] });
    });

    it('is what the check, the flow and the list say too', async () => {
        const graph = postingUpload(await upload(OTHER_GUILD_ID));
        const { flowId } = await createFlow(graph);

        const checked = await send<{ issues: Issue[] }>('POST', `/flows/${flowId}/check`, { graph });
        const read = await send<{ issues: Issue[] }>('GET', `/flows/${flowId}`);
        const listed = await send<{ flows: { flowId: string; issueCount: number }[] }>('GET', '/flows');

        expect(checked.body.issues).toEqual([NOT_HERE]);
        expect(read.body.issues).toEqual([NOT_HERE]);
        expect(listed.body.flows.find((flow) => flow.flowId === flowId)?.issueCount).toBe(1);
    });
});

describe("a graph showing this server's own upload", () => {
    it('is ready, and switches on', async () => {
        const { flowId, issues } = await createFlow(postingUpload(await upload(GUILD_ID)));

        const switched = await send<{ enabled: boolean; issues: Issue[] }>('PUT', `/flows/${flowId}`, { enabled: true });

        expect(issues).toEqual([]);
        expect(switched.status).toBe(200);
        expect(switched.body).toMatchObject({ enabled: true, issues: [] });
    });
});

describe("a live flow saved with another server's upload", () => {
    /**
     * The live flow shows this server's upload and the save names another's: two graphs, each
     * judged against the uploads it names — the draft's issue on its part, the live flow's
     * none — though the save only read the uploads of the graph it judged.
     */
    it('goes to the saver’s draft, its issue on the part, the live flow still ready', async () => {
        const { flowId } = await createFlow(postingUpload(await upload(GUILD_ID)));
        const switched = await send<{ enabled: boolean }>('PUT', `/flows/${flowId}`, { enabled: true });
        expect(switched.body.enabled).toBe(true);

        const saved = await send<{ savedAs: string; issues: Issue[]; draft: { issues: Issue[] } }>(
            'PUT',
            `/flows/${flowId}`,
            { graph: postingUpload(await upload(OTHER_GUILD_ID)) }
        );

        expect(saved.status).toBe(200);
        expect(saved.body.savedAs).toBe('draft');
        expect(saved.body.draft.issues).toEqual([
            { nodeId: 'post', field: 'message.embeds.0.image', message: expect.stringMatching(/That uploaded picture isn't in this server/) },
        ]);
        expect(saved.body.issues).toEqual([]);
    });
});
