import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Client } from 'discord.js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { database } from '../../../features-system/data-persistence/database';
import { guildUploadsRepo } from '../../../features-system/guild-uploads';
import { migrateTestDatabase } from '../../../features-system/data-persistence/__tests__/support/migrateTestDatabase';
import { MIB } from '../../../shared/byteSizes';
import {
    TestDiscord,
    type ServerChannel,
    type ServerGuild,
    type ServerMember,
} from '../../../shared/__tests__/support/testDiscord';
import { ACTION_POST_EMBED } from '../blocks/actionPostEmbed';
import { ensureBlocksDiscovered } from '../blocks/registry';
import { TRIGGER_MESSAGE_SENT } from '../blocks/triggerMessageSent';
import { TRIGGER_SCHEDULE } from '../blocks/triggerSchedule';
import { FLOW_GRAPH_VERSION, type FlowGraph } from '../data/flowGraph';
import { executeFlow, type FlowRunResult } from '../engine/executor';

/**
 * Post Embed, run for real: the executor, the uploads repo on the migrated schema, and
 * discord.js against TestDiscord — so an uploaded picture is proven by the multipart request
 * Discord would receive, not by what the block handed a mock.
 *
 * Every run starts from a Schedule trigger (a run about nobody), which is all Post Embed
 * needs: it picks its own channel.
 */

const discord = new TestDiscord();
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

let client: Client<true>;
let home: { guild: ServerGuild; channel: ServerChannel; member: ServerMember };
let elsewhere: ServerGuild;

/** A PNG of roughly `size` bytes, different every time so no two uploads deduplicate. */
function png(size = 64): Buffer {
    return Buffer.concat([PNG_SIGNATURE, randomBytes(Math.max(size - PNG_SIGNATURE.length, 1))]);
}

/** Store `bytes` as an upload of `guildId`, returning its id. */
async function upload(guildId: string, bytes: Buffer = png()): Promise<string> {
    const { upload: stored } = await guildUploadsRepo.create({
        guildId,
        fileName: 'collar.png',
        contentType: 'image/png',
        sha256: createHash('sha256').update(bytes).digest('hex'),
        bytes,
        uploadedBy: 'operator-1',
    });
    return stored.uploadId;
}

/**
 * Schedule → Post Embed into `channelId` (the home channel unless named), holding `message`
 * and, when given, `buttons`.
 */
function posting(message: Record<string, unknown>, channelId: string = home.channel.id, buttons?: readonly unknown[]): FlowGraph {
    return {
        version: FLOW_GRAPH_VERSION,
        nodes: [
            { id: 'clock', type: TRIGGER_SCHEDULE, position: { x: 0, y: 0 }, data: { repeat: 'daily', time: '09:00' } },
            {
                id: 'post',
                type: ACTION_POST_EMBED,
                position: { x: 0, y: 160 },
                data: { channelId, message, ...(buttons ? { buttons } : {}) },
            },
        ],
        edges: [{ id: 'e1', source: 'clock', target: 'post' }],
    };
}

interface RunOptions {
    /** What an earlier block recorded, for `{{var.<name>}}` to read. */
    readonly variables?: Record<string, string>;
    readonly channelId?: string;
    readonly buttons?: readonly unknown[];
}

function run(message: Record<string, unknown>, options: RunOptions = {}): Promise<FlowRunResult> {
    return executeFlow('flow-1', posting(message, options.channelId, options.buttons), 'clock', {
        client,
        guild: discord.clientGuild(home.guild),
        variables: options.variables ?? {},
    });
}

/** The writes the bot has sent into the home channel since `from`. */
function writesSince(from: number) {
    return discord.writesTo(home.channel).slice(from);
}

beforeAll(async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    // The executor logs every failed run, and three of these fail on purpose.
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await ensureBlocksDiscovered();
    await migrateTestDatabase();
    const guild = discord.createGuild({ bot: { permissions: ['SendMessages', 'EmbedLinks', 'AttachFiles'] } });
    home = { guild, channel: guild.createTextChannel({ name: 'dungeon-notices' }), member: guild.createMember({ username: 'brat' }) };
    elsewhere = discord.createGuild();
    elsewhere.createTextChannel({ name: 'not-yours' });
    client = await discord.start();
}, 30_000);

afterAll(async () => {
    vi.restoreAllMocks();
    await discord.destroy();
});

describe('Post Embed posting an uploaded picture', () => {
    it('sends plain text, two embeds and the upload as one multipart message, the embed pointing at the file', async () => {
        const bytes = png();
        const uploadId = await upload(home.guild.id, bytes);
        const from = discord.writesTo(home.channel).length;

        const result = await run({
            content: `Inspection at nine, <@${home.member.id}>.`,
            embeds: [
                { title: 'Dress code', description: 'Collars on.', thumbnail: `upload:${uploadId}` },
                { title: 'Venue', image: 'https://example.com/dungeon.png' },
            ],
        });

        expect(result.status).toBe('success');
        const writes = writesSince(from);
        expect(writes).toHaveLength(1);
        const [request] = writes;
        expect(request?.files).toEqual([{ index: 0, name: `${uploadId}.png`, contentType: 'image/png', bytes }]);
        expect(request?.body).toMatchObject({
            content: `Inspection at nine, <@${home.member.id}>.`,
            embeds: [
                { title: 'Dress code', description: 'Collars on.', thumbnail: { url: `attachment://${uploadId}.png` } },
                { title: 'Venue', image: { url: 'https://example.com/dungeon.png' } },
            ],
            attachments: [{ id: '0' }],
            // As Send Message pins them: the member above is pinged, nobody else could be.
            allowed_mentions: { parse: ['users'] },
        });

        const posted = home.channel.messages.at(-1);
        expect(posted?.content).toBe(`Inspection at nine, <@${home.member.id}>.`);
        expect(posted?.embeds).toHaveLength(2);
        expect(posted?.attachments).toEqual([{ filename: `${uploadId}.png`, size: bytes.length, contentType: 'image/png' }]);
    });

    it('attaches an upload once, however many parts show it', async () => {
        const uploadId = await upload(home.guild.id);
        const from = discord.writesTo(home.channel).length;

        const result = await run({
            embeds: [
                {
                    title: 'Branded',
                    thumbnail: `upload:${uploadId}`,
                    footer: { text: 'Property of the house.', iconUrl: `upload:${uploadId}` },
                },
                { title: 'Again', image: `upload:${uploadId}` },
            ],
        });

        expect(result.status).toBe('success');
        const [request] = writesSince(from);
        expect(request?.files?.map((file) => file.name)).toEqual([`${uploadId}.png`]);
        expect(request?.body).toMatchObject({
            embeds: [
                {
                    thumbnail: { url: `attachment://${uploadId}.png` },
                    footer: { icon_url: `attachment://${uploadId}.png` },
                },
                { image: { url: `attachment://${uploadId}.png` } },
            ],
        });
    });

    it('fails naming the part when the upload is not in the server, and posts nothing', async () => {
        const from = discord.writesTo(home.channel).length;

        const result = await run({ embeds: [{ title: 'Ghost', image: `upload:${randomUUID()}` }] });

        expect(result.status).toBe('error');
        expect(result.error).toContain(`"Message" embed 1 image: That uploaded picture isn't in this server.`);
        expect(writesSince(from)).toEqual([]);
    });

    it("fails the same way for another server's upload, though the id exists", async () => {
        const theirs = await upload(elsewhere.id);
        const from = discord.writesTo(home.channel).length;

        const result = await run({
            embeds: [{ title: 'Borrowed', footer: { text: 'Not ours.', iconUrl: `upload:${theirs}` } }],
        });

        expect(result.status).toBe('error');
        expect(result.error).toContain(`"Message" embed 1 footer icon: That uploaded picture isn't in this server.`);
        expect(writesSince(from)).toEqual([]);
    });

    it('fails giving the number when the uploads together are over what a message may carry, reading no bytes', async () => {
        const first = await upload(home.guild.id, png(5.5 * MIB));
        const second = await upload(home.guild.id, png(5.5 * MIB));
        const from = discord.writesTo(home.channel).length;
        const filesFor = vi.spyOn(guildUploadsRepo, 'filesFor');

        const result = await run({
            embeds: [{ title: 'Too much', thumbnail: `upload:${first}`, image: `upload:${second}` }],
        });

        expect(result.status).toBe('error');
        expect(result.error).toMatch(/come to 11\.0 MB, and Discord takes 10 MB a message/);
        // Judged on the sizes alone: eleven megabytes were never read to be refused.
        expect(filesFor).not.toHaveBeenCalled();
        expect(writesSince(from)).toEqual([]);
        filesFor.mockRestore();
    });

    it('fails giving the number when the message shows more uploads than Discord attaches to one message', async () => {
        const uploadIds = await Promise.all(Array.from({ length: 11 }, () => upload(home.guild.id)));
        const from = discord.writesTo(home.channel).length;

        // Ten embeds, each with its own image, and the first with an eleventh as its thumbnail.
        const embeds: Record<string, unknown>[] = uploadIds
            .slice(0, 10)
            .map((uploadId, index) => ({ title: `Exhibit ${index + 1}`, image: `upload:${uploadId}` }));
        const result = await run({ embeds: [{ ...embeds[0], thumbnail: `upload:${uploadIds[10]}` }, ...embeds.slice(1)] });

        expect(result.status).toBe('error');
        expect(result.error).toMatch(/shows 11 different uploaded pictures, and Discord takes 10 files a message/);
        expect(writesSince(from)).toEqual([]);
    });

    it('checks the channel before reading anything about the uploads', async () => {
        const uploadId = await upload(home.guild.id);
        const sizesFor = vi.spyOn(guildUploadsRepo, 'sizesFor');
        const filesFor = vi.spyOn(guildUploadsRepo, 'filesFor');

        const result = await run(
            { embeds: [{ title: 'Nowhere to go', image: `upload:${uploadId}` }] },
            { channelId: '999999999999999999' }
        );

        expect(result.status).toBe('error');
        expect(result.error).toMatch(/not a sendable text channel in this server/);
        expect(sizesFor).not.toHaveBeenCalled();
        expect(filesFor).not.toHaveBeenCalled();
        sizesFor.mockRestore();
        filesFor.mockRestore();
    });
});

describe('Post Embed with buttons', () => {
    /** The records of every message posted with buttons into the home channel. */
    async function records() {
        return database.selectFrom('flow_posted_messages').selectAll().where('channelId', '=', home.channel.id).execute();
    }

    it('posts its buttons as mbtn: rows of five, and records the post against the flow, node and run', async () => {
        const recordsBefore = (await records()).length;
        const buttons = Array.from({ length: 6 }, (_unused, index) => ({
            key: `pick-${index + 1}`,
            label: `Pick ${index + 1}`,
            style: index === 5 ? 'Danger' : 'Primary',
        }));
        const from = discord.writesTo(home.channel).length;

        const result = await run({ embeds: [{ title: 'Choose your poison' }] }, { buttons });

        expect(result.status).toBe('success');
        const [request] = writesSince(from);
        expect(request?.body).toMatchObject({
            components: [
                { type: 1, components: buttons.slice(0, 5).map((button) => ({ type: 2, custom_id: `mbtn:${button.key}`, label: button.label })) },
                { type: 1, components: [{ type: 2, custom_id: 'mbtn:pick-6', label: 'Pick 6', style: 4 }] },
            ],
        });

        const posted = home.channel.messages.at(-1);
        const added = (await records()).slice(recordsBefore);
        expect(added).toEqual([
            {
                messageId: posted?.id,
                guildId: home.guild.id,
                channelId: home.channel.id,
                flowId: 'flow-1',
                nodeId: 'post',
                runId: result.runId,
                // A Schedule's run is about nobody, and Post Embed opens no ticket.
                subjectId: null,
                ticketId: null,
                postedAt: expect.any(Date),
            },
        ]);
    });

    it('posts in the channel the run happened in, and records the post against that channel', async () => {
        const recordsBefore = (await records()).length;
        const room = home.guild.createTextChannel({ name: 'confession-booth' });
        const roomWrites = discord.writesTo(room).length;
        const homeWrites = discord.writesTo(home.channel).length;
        const clientGuild = discord.clientGuild(home.guild);
        const runChannel = clientGuild.channels.cache.get(room.id);
        if (!runChannel?.isTextBased()) throw new Error('TestDiscord did not cache the room as a text channel');
        // A message landing in the room started this run — the channel a Message Sent run carries.
        const graph: FlowGraph = {
            version: FLOW_GRAPH_VERSION,
            nodes: [
                { id: 'said', type: TRIGGER_MESSAGE_SENT, position: { x: 0, y: 0 }, data: { where: 'anywhere' } },
                {
                    id: 'post',
                    type: ACTION_POST_EMBED,
                    position: { x: 0, y: 160 },
                    // The picker still names the home channel from before the switch; hidden, it is never read.
                    data: {
                        where: 'here',
                        channelId: home.channel.id,
                        message: { embeds: [{ title: 'Confess.' }] },
                        buttons: [{ key: 'sin', label: 'Sin', style: 'Danger' }],
                    },
                },
            ],
            edges: [{ id: 'e1', source: 'said', target: 'post' }],
        };

        const result = await executeFlow('flow-1', graph, 'said', {
            client,
            guild: clientGuild,
            channel: runChannel,
            variables: {},
        });

        expect(result.status).toBe('success');
        expect(discord.writesTo(room).slice(roomWrites)).toHaveLength(1);
        expect(discord.writesTo(home.channel).slice(homeWrites)).toEqual([]);
        const posted = room.messages.at(-1);
        const added = await database
            .selectFrom('flow_posted_messages')
            .selectAll()
            .where('messageId', '=', posted?.id ?? '')
            .execute();
        expect(added).toEqual([expect.objectContaining({ channelId: room.id, nodeId: 'post', runId: result.runId })]);
        // Nothing recorded against the home channel the picker still names.
        expect(await records()).toHaveLength(recordsBefore);
    });

    it('posts no rows and records nothing without buttons, or with an empty list', async () => {
        const recordsBefore = (await records()).length;
        const from = discord.writesTo(home.channel).length;

        expect((await run({ embeds: [{ title: 'No buttons' }] })).status).toBe('success');
        expect((await run({ embeds: [{ title: 'Empty list' }] }, { buttons: [] })).status).toBe('success');

        for (const request of writesSince(from)) {
            expect(request.body).toMatchObject({ components: [] });
        }
        expect(await records()).toHaveLength(recordsBefore);
    });
});

describe('Post Embed with a picture that is a token', () => {
    /**
     * A picture token's value is anything an earlier block recorded — text a member wrote,
     * say. One that came out as `upload:<id>` must not be attached as an upload: it would
     * post a picture nobody picked, past every save-time upload check. Refused instead, as
     * any picture token that did not come out as a link is.
     */
    it("refuses one that came out as an upload ref, even this server's own, naming the part", async () => {
        const uploadId = await upload(home.guild.id);
        const from = discord.writesTo(home.channel).length;

        const result = await run(
            { embeds: [{ title: 'Smuggled', image: '{{var.pic}}' }] },
            { variables: { pic: `upload:${uploadId}` } }
        );

        expect(result.status).toBe('error');
        expect(result.error).toContain(`"Message" embed 1 image came out as "upload:${uploadId}"`);
        expect(writesSince(from)).toEqual([]);
    });

    it('posts one that came out as a link', async () => {
        const from = discord.writesTo(home.channel).length;

        const result = await run(
            { embeds: [{ title: 'Linked', image: '{{var.pic}}' }] },
            { variables: { pic: 'https://example.com/leash.png' } }
        );

        expect(result.status).toBe('success');
        const [request] = writesSince(from);
        expect(request?.files ?? []).toEqual([]);
        expect(request?.body).toMatchObject({ embeds: [{ image: { url: 'https://example.com/leash.png' } }] });
    });
});
