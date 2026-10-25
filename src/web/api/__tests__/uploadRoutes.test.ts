import { createHash, randomBytes } from 'node:crypto';
import { Hono } from 'hono';
import { beforeAll, describe, expect, it } from 'vitest';
import { database } from '../../../features-system/data-persistence/database';
import { migrateTestDatabase } from '../../../features-system/data-persistence/__tests__/support/migrateTestDatabase';
import { GUILD_UPLOAD_TOTAL_LIMIT_BYTES, registerUploadUsageReader } from '../../../features-system/guild-uploads';
import { ACTION_POST_EMBED } from '../../../features/flows/blocks/actionPostEmbed';
import { ensureBlocksDiscovered } from '../../../features/flows/blocks/registry';
import { flowDraftsRepo } from '../../../features/flows/data/flowDraftsRepo';
import { FLOW_GRAPH_VERSION, type FlowGraph } from '../../../features/flows/data/flowGraph';
import { flowsRepo } from '../../../features/flows/data/flowsRepo';
import { flowUploadUses } from '../../../features/flows/logic/flowUploadUses';
import { initProvisioning, journeysRepo } from '../../../features/provisioning';
import type { AppEnv } from '../../types';
import type { GuildUploadBody, GuildUploadListBody, UploadUseBody } from '../uploadBody';
import {
    UPLOAD_GUILD_FULL_SENTENCE,
    UPLOAD_IN_USE_SENTENCE,
    UPLOAD_NOT_AN_IMAGE_SENTENCE,
    UPLOAD_NOT_FOUND_SENTENCE,
    UPLOAD_NOT_RAW_BYTES_SENTENCE,
    uploadRoutes,
} from '../uploadRoutes';

/**
 * The upload routes through the real router, `storeGuildUpload` and repo, on an in-memory
 * SQLite built by the real migrations — and, for what uses a picture, flows' real reader
 * over real flows and drafts, registered as `initFlows` does.
 *
 * `uploadRoutes()` is mounted bare, as in production its auth, rate limit and guild access
 * sit on the parent: these tests put the user and guild on the context the way those do.
 * What the parent decides — the body cap, the 403 for a server you may not manage — is
 * asserted against the whole app in `buildApp.test.ts`.
 *
 * Each case uses its own guild, so the shared database never couples two of them.
 */

const OPERATOR = { id: 'user-operator', username: 'operator', avatar: null, manageableGuildIds: [] };

function app(guildId: string) {
    const outer = new Hono<AppEnv>();
    outer.use('*', async (c, next) => {
        c.set('user', OPERATOR);
        c.set('guild', { id: guildId } as never);
        await next();
    });
    outer.route('/', uploadRoutes());
    return outer;
}

/** A PNG-headed picture with random bytes after it, so each call is a different picture. */
function png(size = 512): Buffer {
    return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), randomBytes(size)]);
}

function upload(guildId: string, bytes: Uint8Array, query = '?name=cat.png', contentType = 'application/octet-stream') {
    return app(guildId).request(`/${guildId}/uploads${query}`, {
        method: 'POST',
        headers: { 'Content-Type': contentType },
        body: bytes,
    });
}

/** Upload a fresh picture to `guildId` and answer its row. */
async function kept(guildId: string): Promise<GuildUploadBody> {
    return (await (await upload(guildId, png())).json()) as GuildUploadBody;
}

/** One Post Embed node, `post`, whose first embed shows `uploadId` as its image. */
function showing(uploadId: string): FlowGraph {
    return {
        version: FLOW_GRAPH_VERSION,
        nodes: [
            {
                id: 'post',
                type: ACTION_POST_EMBED,
                position: { x: 0, y: 0 },
                data: { channelId: '1', message: { embeds: [{ title: 'Look', image: `upload:${uploadId}` }] } },
            },
        ],
        edges: [],
    };
}

/** A saved flow showing `uploadId`, and a draft of another flow showing it too. */
async function useInFlowAndDraft(guildId: string, uploadId: string): Promise<UploadUseBody[]> {
    const live = await flowsRepo.create({ guildId, name: 'Welcome flow', graph: showing(uploadId) });
    const drafted = await flowsRepo.create({ guildId, name: 'Goodbye flow', graph: { ...showing(uploadId), nodes: [] } });
    await flowDraftsRepo.upsertMine({
        flowId: drafted.flowId,
        guildId,
        authorId: 'user-drafter',
        authorName: 'drafter',
        name: 'Goodbye flow',
        graph: showing(uploadId),
        baseUpdatedAt: new Date().toISOString(),
    });
    const at = { kind: 'flow' as const, nodeId: 'post', blockLabel: 'Post Embed', where: 'embed 1 image' };
    return [
        { flowId: live.flowId, flowName: 'Welcome flow', ...at },
        { flowId: drafted.flowId, flowName: 'Goodbye flow', ...at, draftAuthorId: 'user-drafter' },
    ];
}

/**
 * A journey declaring a channel and a message whose header icon and image show `uploadId` —
 * not installed, since a declaration is what install posts.
 */
async function useInJourneyMessage(guildId: string, uploadId: string): Promise<UploadUseBody[]> {
    await journeysRepo.create({
        guildId,
        journeyKey: 'onboarding',
        name: 'Onboarding',
        resources: [
            { key: 'rules', kind: 'textChannel', defaultName: 'rules' },
            {
                key: 'rules-panel',
                kind: 'message',
                defaultName: 'Rules panel',
                parentKey: 'rules',
                message: {
                    embeds: [{ title: 'House rules', author: { name: 'Mgmt', iconUrl: `upload:${uploadId}` }, image: `upload:${uploadId}` }],
                },
            },
        ],
    });
    const at = { kind: 'journeyMessage' as const, journeyKey: 'onboarding', journeyName: 'Onboarding', resourceKey: 'rules-panel', messageName: 'Rules panel' };
    return [
        { ...at, where: 'embed 1 header icon' },
        { ...at, where: 'embed 1 image' },
    ];
}

function remove(guildId: string, uploadId: string) {
    return app(guildId).request(`/${guildId}/uploads/${uploadId}`, { method: 'DELETE' });
}

beforeAll(async () => {
    await ensureBlocksDiscovered();
    await migrateTestDatabase();
    // As `bot.ts` wires them: journeys' message resources, then flows.
    initProvisioning();
    registerUploadUsageReader(flowUploadUses);
});

describe('POST /:guildId/uploads', () => {
    it('keeps a new picture with 201, then answers the same bytes again with 200 and the first row', async () => {
        const bytes = png();

        const first = await upload('guild-dedupe', bytes);
        const firstBody = (await first.json()) as GuildUploadBody;
        const again = await upload('guild-dedupe', bytes, '?name=renamed.png');

        expect(first.status).toBe(201);
        expect(firstBody).toEqual({
            uploadId: expect.stringMatching(/^[0-9a-f-]{36}$/),
            fileName: 'cat.png',
            contentType: 'image/png',
            byteSize: bytes.length,
            uploadedBy: OPERATOR.id,
            createdAt: expect.any(String),
        });
        expect(again.status).toBe(200);
        expect(await again.json()).toEqual(firstBody);
    });

    it('takes the type from the bytes, whatever the name says', async () => {
        const gif = Buffer.concat([Buffer.from('GIF89a', 'ascii'), randomBytes(64)]);

        const response = await upload('guild-sniff', gif, '?name=totally-a.png');

        expect(response.status).toBe(201);
        expect(((await response.json()) as GuildUploadBody).contentType).toBe('image/gif');
    });

    it('refuses bytes that are not a picture with 415, and keeps nothing', async () => {
        const response = await upload('guild-415', Buffer.from('this is definitely a png, trust me'), '?name=cat.png');

        expect(response.status).toBe(415);
        expect(await response.json()).toEqual({ error: UPLOAD_NOT_AN_IMAGE_SENTENCE });
        expect(await database.selectFrom('guild_uploads').where('guildId', '=', 'guild-415').selectAll().execute()).toEqual([]);
    });

    it('refuses a body not sent as raw bytes with 415, even when it is a picture', async () => {
        const response = await upload('guild-415-type', png(), '?name=cat.png', 'text/plain');

        expect(response.status).toBe(415);
        expect(await response.json()).toEqual({ error: UPLOAD_NOT_RAW_BYTES_SENTENCE });
    });

    it('refuses a new picture with 409 once the server is at its total, but still answers a re-upload', async () => {
        const guildId = 'guild-full';
        const kept = png();
        expect((await upload(guildId, kept)).status).toBe(201);
        // A row whose recorded size fills the rest of the server's allowance.
        await database
            .insertInto('guild_uploads')
            .values({
                uploadId: 'filler',
                guildId,
                fileName: 'filler.png',
                contentType: 'image/png',
                byteSize: GUILD_UPLOAD_TOTAL_LIMIT_BYTES - kept.length,
                sha256: 'filler-sha',
                bytes: Buffer.from([0]),
                uploadedBy: OPERATOR.id,
                createdAt: new Date().toISOString(),
            })
            .execute();

        const refused = await upload(guildId, png(1));
        const reupload = await upload(guildId, kept);

        expect(refused.status).toBe(409);
        expect(await refused.json()).toEqual({ error: UPLOAD_GUILD_FULL_SENTENCE });
        expect(reupload.status).toBe(200);
    });

    it('keeps the last segment of a path-like name, cleaned and cut to 100 characters', async () => {
        const longName = `C:\\fakepath\\${'a'.repeat(150)}\u0007.png`;

        const response = await upload('guild-names', png(), `?name=${encodeURIComponent(longName)}`);

        expect(response.status).toBe(201);
        expect(((await response.json()) as GuildUploadBody).fileName).toBe('a'.repeat(100));
    });

    it('collapses whitespace and drops control and bidi characters from the name', async () => {
        const response = await upload('guild-names-controls', png(), `?name=${encodeURIComponent('ca\u0007t\t\t‮.png')}`);

        expect(response.status).toBe(201);
        expect(((await response.json()) as GuildUploadBody).fileName).toBe('cat .png');
    });

    it('holds the server total when several new pictures race for the last of it', async () => {
        const guildId = 'guild-race';
        // Room for exactly one of the pictures below.
        await database
            .insertInto('guild_uploads')
            .values({
                uploadId: 'race-filler',
                guildId,
                fileName: 'filler.png',
                contentType: 'image/png',
                byteSize: GUILD_UPLOAD_TOTAL_LIMIT_BYTES - 1000,
                sha256: 'race-filler-sha',
                bytes: Buffer.from([0]),
                uploadedBy: OPERATOR.id,
                createdAt: new Date().toISOString(),
            })
            .execute();

        const statuses = (await Promise.all(Array.from({ length: 5 }, () => upload(guildId, png(600))))).map(
            (response) => response.status
        );

        expect(statuses.filter((status) => status === 201)).toHaveLength(1);
        expect(statuses.filter((status) => status === 409)).toHaveLength(4);
    });

    it('names a picture sent without a name after its sniffed type', async () => {
        const response = await upload('guild-unnamed', png(), '');

        expect(response.status).toBe(201);
        expect(((await response.json()) as GuildUploadBody).fileName).toBe('image.png');
    });
});

describe('GET /:guildId/uploads', () => {
    it("lists the server's uploads newest first, and no other server's", async () => {
        const older = (await (await upload('guild-list', png())).json()) as GuildUploadBody;
        const newer = (await (await upload('guild-list', png())).json()) as GuildUploadBody;
        await upload('guild-list-other', png());

        const response = await app('guild-list').request('/guild-list/uploads');

        expect(response.status).toBe(200);
        expect(((await response.json()) as GuildUploadListBody).uploads).toEqual([
            { ...newer, uses: [] },
            { ...older, uses: [] },
        ]);
    });

    it("carries each upload's uses, saved and drafted, the total taken and the cap", async () => {
        const guildId = 'guild-list-uses';
        const used = await kept(guildId);
        const unused = await kept(guildId);
        const uses = await useInFlowAndDraft(guildId, used.uploadId);
        // A flow naming an upload this server does not hold — copied from another — lists nothing.
        await flowsRepo.create({ guildId, name: 'Borrowed', graph: showing((await kept('guild-list-uses-other')).uploadId) });

        const response = await app(guildId).request(`/${guildId}/uploads`);

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({
            uploads: [
                { ...unused, uses: [] },
                { ...used, uses },
            ],
            totalBytes: used.byteSize + unused.byteSize,
            limitBytes: GUILD_UPLOAD_TOTAL_LIMIT_BYTES,
        });
    });
});

describe('DELETE /:guildId/uploads/:uploadId', () => {
    it('deletes a picture nothing shows with 204, and it is gone after', async () => {
        const guildId = 'guild-delete';
        const { uploadId } = await kept(guildId);

        const response = await remove(guildId, uploadId);

        expect(response.status).toBe(204);
        expect((await app(guildId).request(`/${guildId}/uploads/${uploadId}`)).status).toBe(404);
        expect(((await (await app(guildId).request(`/${guildId}/uploads`)).json()) as GuildUploadListBody).uploads).toEqual([]);
    });

    it('refuses with 409 and every use while a saved flow or a draft shows it, and keeps it', async () => {
        const guildId = 'guild-delete-in-use';
        const { uploadId } = await kept(guildId);
        const uses = await useInFlowAndDraft(guildId, uploadId);

        const response = await remove(guildId, uploadId);

        expect(response.status).toBe(409);
        expect(await response.json()).toEqual({ error: UPLOAD_IN_USE_SENTENCE, uses });
        expect((await app(guildId).request(`/${guildId}/uploads/${uploadId}`)).status).toBe(200);
    });

    it("refuses with 409 while a journey's message shows it, listing each place, and keeps it", async () => {
        const guildId = 'guild-delete-journey-use';
        const { uploadId } = await kept(guildId);
        const uses = await useInJourneyMessage(guildId, uploadId);
        // Another server's journey naming the same id is not a use here.
        await useInJourneyMessage('guild-delete-journey-use-other', uploadId);

        const response = await remove(guildId, uploadId);

        expect(response.status).toBe(409);
        expect(await response.json()).toEqual({ error: UPLOAD_IN_USE_SENTENCE, uses });
        expect((await app(guildId).request(`/${guildId}/uploads/${uploadId}`)).status).toBe(200);
    });

    it("answers 404 for another server's upload, even one this server's flow names, and leaves it", async () => {
        const { uploadId } = await kept('guild-delete-owner');
        await flowsRepo.create({ guildId: 'guild-delete-snoop', name: 'Borrowed', graph: showing(uploadId) });

        const response = await remove('guild-delete-snoop', uploadId);

        expect(response.status).toBe(404);
        expect(await response.json()).toEqual({ error: UPLOAD_NOT_FOUND_SENTENCE });
        expect((await app('guild-delete-owner').request(`/guild-delete-owner/uploads/${uploadId}`)).status).toBe(200);
    });

    it('answers 404 for an upload that does not exist', async () => {
        const response = await remove('guild-delete-missing', 'no-such-upload');

        expect(response.status).toBe(404);
        expect(await response.json()).toEqual({ error: UPLOAD_NOT_FOUND_SENTENCE });
    });
});

describe('GET /:guildId/uploads/:uploadId', () => {
    it('answers the bytes as their sniffed type, marked nosniff', async () => {
        const bytes = png(2048);
        const { uploadId } = (await (await upload('guild-get', bytes)).json()) as GuildUploadBody;

        const response = await app('guild-get').request(`/guild-get/uploads/${uploadId}`);
        const served = Buffer.from(await response.arrayBuffer());

        expect(response.status).toBe(200);
        expect(response.headers.get('Content-Type')).toBe('image/png');
        expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
        expect(createHash('sha256').update(served).digest('hex')).toBe(createHash('sha256').update(bytes).digest('hex'));
    });

    it("answers 404 for another server's upload, as for one that does not exist", async () => {
        const { uploadId } = (await (await upload('guild-owner', png())).json()) as GuildUploadBody;

        const foreign = await app('guild-snoop').request(`/guild-snoop/uploads/${uploadId}`);
        const missing = await app('guild-snoop').request('/guild-snoop/uploads/no-such-upload');

        expect(foreign.status).toBe(404);
        expect(await foreign.json()).toEqual({ error: UPLOAD_NOT_FOUND_SENTENCE });
        expect(missing.status).toBe(404);
    });
});
