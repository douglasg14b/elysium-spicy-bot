import { Migrator, sql } from 'kysely';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ensureBlocksDiscovered } from '../../../features/flows/blocks/registry';
import type { FlowGraph, FlowNode } from '../../../features/flows/data/flowGraph';
import { validateNodeData } from '../../../features/flows/engine/nodeDataValidation';
import { database } from '../database';
import { FileMigrationProvider } from '../fileMigrationProvider';
import { up as postEmbedMessageShape } from '../migrations/2026-10-24-Post_Embed_Message_Shape';
import { migrateTestDatabase } from './support/migrateTestDatabase';

/**
 * `2026-10-24-Post_Embed_Message_Shape` on SQLite, through a real `Migrator` on the
 * production `database` stack — `CamelCasePlugin`, and `SqliteJsonPlugin` parsing both
 * `graph` columns — after the pattern of `ownerKeyedResourceBindingsMigration.test.ts`.
 *
 * The old shape is seeded with raw SQL after migrating down to the migration before. The
 * stored text is read back under an alias the JSON plugin does not parse, so the exact
 * serialized output is what is pinned. Every complete node it writes is then held to the
 * **live** `validateNodeData`, which ties the transform frozen in the migration to the
 * block's schema today.
 *
 * Postgres is not covered here: CI runs SQLite only. It was run by hand against a throwaway
 * `postgres:16` — see "As built (slices A–C)" in `docs/plans/message-editor-step-1.md`.
 */

const BEFORE = '2026-10-24-Create_Guild_Uploads';
const CHANNEL = '1100000000000000001';
const UPLOAD = 'upload:0f0e0d0c-0b0a-4908-8706-050403020100';
const POST_EMBED = 'action.postEmbed';

const migrator = new Migrator({ db: database, provider: new FileMigrationProvider() });

async function migrateOrThrow(run: Promise<{ error?: unknown }>): Promise<void> {
    const { error } = await run;
    if (error) throw error;
}

function node(id: string, type: string, data: Record<string, unknown>): FlowNode {
    return { id, type, position: { x: 0, y: 0 }, data };
}

function graphOf(nodes: FlowNode[]): FlowGraph {
    return { version: 1, nodes, edges: [] };
}

/** Post Embed nodes in the flat shape, as the block before this change stored them. */
const OLD = {
    complete: {
        channelId: CHANNEL,
        title: 'House Rules',
        description: 'Read them.',
        color: '#00A2FF',
        url: 'https://example.com/rules',
        authorName: 'The Management',
        fields: [
            { name: 'Safewords', value: 'Red means stop.', inline: true },
            { name: 'Consent', value: 'Enthusiastic, or not at all.' },
        ],
        imageUrl: 'https://example.com/banner.png',
        thumbnailUrl: 'https://example.com/icon.png',
        footerText: 'Behave yourselves.',
        showTimestamp: 'true',
        // A key this block never had: it stays where it was.
        legacyNote: 'kept',
    },
    incomplete: { channelId: '', title: '', description: 'Half done.', color: '#FF2D95', fields: [], showTimestamp: 'false' },
    sidecar: {
        channelId: '',
        channelIdKey: 'rules-channel',
        title: 'Rules',
        description: 'Posted on install.',
        showTimestamp: 'false',
    },
    tokens: {
        channelId: CHANNEL,
        title: 'Welcome',
        description: 'Hi {{subject.mention}}',
        thumbnailUrl: '{{subject.avatarUrl}}',
        imageUrl: 'https://cdn.example.com/{{var.pic}}.png',
        fields: [{ name: 'Who', value: '{{subject.username}}', inline: false }],
        showTimestamp: 'true',
    },
    // Both links passed zod's `.url()` and fail the new pattern: kept, and logged.
    refused: {
        channelId: CHANNEL,
        title: 'Odd',
        description: 'Spacey',
        url: 'https://example.com/a b',
        imageUrl: 'https://example.com/my pic.png',
    },
    // Fits the new pattern, and parses as no URL — discord.js's `setURL` throws on it.
    unparseable: { channelId: CHANNEL, title: 'Percent', url: 'https://a%zz/x' },
} as const;

/** A node the builder already wrote in the new shape, uploads and all. */
const ALREADY_MIGRATED = {
    channelId: CHANNEL,
    message: {
        content: 'Hi',
        embeds: [{ title: 'Already', thumbnail: UPLOAD, footer: { text: 'f', iconUrl: UPLOAD } }, { title: 'Second' }],
    },
};

const SEND_MESSAGE = { channelId: CHANNEL, message: 'Hello' };

const FLOW_GRAPH = graphOf([
    node('trigger', 'trigger.buttonClick', { button: { messageKey: 'panel', buttonKey: 'go' } }),
    node('complete', POST_EMBED, OLD.complete),
    node('incomplete', POST_EMBED, OLD.incomplete),
    node('sidecar', POST_EMBED, OLD.sidecar),
    node('tokens', POST_EMBED, OLD.tokens),
    node('refused', POST_EMBED, OLD.refused),
    node('unparseable', POST_EMBED, OLD.unparseable),
    node('say', 'action.sendMessage', SEND_MESSAGE),
    node('already', POST_EMBED, ALREADY_MIGRATED),
]);

const DRAFT_GRAPH = graphOf([
    node('draft-post', POST_EMBED, { channelId: CHANNEL, title: 'Draft', imageUrl: 'https://example.com/draft pic.png' }),
    node('say', 'action.sendMessage', SEND_MESSAGE),
]);

/** Each node's data once migrated up, exactly — key order included. */
const UP = {
    complete: {
        channelId: CHANNEL,
        legacyNote: 'kept',
        message: {
            embeds: [
                {
                    color: '#00A2FF',
                    author: { name: 'The Management' },
                    title: 'House Rules',
                    url: 'https://example.com/rules',
                    description: 'Read them.',
                    fields: [
                        { name: 'Safewords', value: 'Red means stop.', inline: true },
                        { name: 'Consent', value: 'Enthusiastic, or not at all.', inline: false },
                    ],
                    thumbnail: 'https://example.com/icon.png',
                    image: 'https://example.com/banner.png',
                    footer: { text: 'Behave yourselves.' },
                    timestamp: true,
                },
            ],
        },
    },
    // The empty title is dropped: absent means left out.
    incomplete: {
        channelId: '',
        message: { embeds: [{ color: '#FF2D95', description: 'Half done.', fields: [], timestamp: false }] },
    },
    sidecar: {
        channelId: '',
        channelIdKey: 'rules-channel',
        message: { embeds: [{ title: 'Rules', description: 'Posted on install.', fields: [], timestamp: false }] },
    },
    tokens: {
        channelId: CHANNEL,
        message: {
            embeds: [
                {
                    title: 'Welcome',
                    description: 'Hi {{subject.mention}}',
                    fields: [{ name: 'Who', value: '{{subject.username}}', inline: false }],
                    thumbnail: '{{subject.avatarUrl}}',
                    image: 'https://cdn.example.com/{{var.pic}}.png',
                    timestamp: true,
                },
            ],
        },
    },
    refused: {
        channelId: CHANNEL,
        message: {
            embeds: [
                {
                    title: 'Odd',
                    url: 'https://example.com/a b',
                    description: 'Spacey',
                    fields: [],
                    image: 'https://example.com/my pic.png',
                    timestamp: false,
                },
            ],
        },
    },
    unparseable: {
        channelId: CHANNEL,
        message: { embeds: [{ title: 'Percent', url: 'https://a%zz/x', fields: [], timestamp: false }] },
    },
} as const;

const FLOW_GRAPH_UP = graphOf([
    node('trigger', 'trigger.buttonClick', { button: { messageKey: 'panel', buttonKey: 'go' } }),
    node('complete', POST_EMBED, UP.complete),
    node('incomplete', POST_EMBED, UP.incomplete),
    node('sidecar', POST_EMBED, UP.sidecar),
    node('tokens', POST_EMBED, UP.tokens),
    node('refused', POST_EMBED, UP.refused),
    node('unparseable', POST_EMBED, UP.unparseable),
    node('say', 'action.sendMessage', SEND_MESSAGE),
    node('already', POST_EMBED, ALREADY_MIGRATED),
]);

const DRAFT_GRAPH_UP = graphOf([
    node('draft-post', POST_EMBED, {
        channelId: CHANNEL,
        message: { embeds: [{ title: 'Draft', fields: [], image: 'https://example.com/draft pic.png', timestamp: false }] },
    }),
    node('say', 'action.sendMessage', SEND_MESSAGE),
]);

async function seedOldShape(): Promise<void> {
    await sql`
        INSERT INTO flows (flow_id, guild_id, name, enabled, graph)
        VALUES ('flow-mixed', 'guild-1', 'Mixed', 0, ${JSON.stringify(FLOW_GRAPH)})
    `.execute(database);
    await sql`
        INSERT INTO flow_drafts (flow_id, guild_id, author_id, author_name, name, graph, base_updated_at)
        VALUES ('flow-mixed', 'guild-1', 'user-1', 'domme', 'Mixed', ${JSON.stringify(DRAFT_GRAPH)}, '2026-10-23T12:00:00.000Z')
    `.execute(database);
}

async function clearSeeds(): Promise<void> {
    await sql`DELETE FROM flow_drafts`.execute(database);
    await sql`DELETE FROM flows`.execute(database);
}

/** Each table's graph text exactly as stored — aliased, so the JSON plugin leaves it a string. */
async function storedText(): Promise<{ flow: string; draft: string }> {
    const flow = await sql<{ serialized: string }>`SELECT graph AS serialized FROM flows`.execute(database);
    const draft = await sql<{ serialized: string }>`SELECT graph AS serialized FROM flow_drafts`.execute(database);
    return { flow: flow.rows[0]?.serialized ?? '', draft: draft.rows[0]?.serialized ?? '' };
}

async function storedGraphs(): Promise<{ flow: FlowGraph; draft: FlowGraph }> {
    const text = await storedText();
    return { flow: JSON.parse(text.flow) as FlowGraph, draft: JSON.parse(text.draft) as FlowGraph };
}

function dataOf(graph: FlowGraph, nodeId: string): Record<string, unknown> | undefined {
    return graph.nodes.find((candidate) => candidate.id === nodeId)?.data;
}

beforeAll(async () => {
    await ensureBlocksDiscovered();
    await migrateTestDatabase();
});

afterEach(async () => {
    vi.restoreAllMocks();
    // Every case leaves the schema at latest and the tables empty, whatever it did.
    await migrateOrThrow(migrator.migrateToLatest());
    await clearSeeds();
});

describe('2026-10-24-Post_Embed_Message_Shape (sqlite, through Migrator)', () => {
    it('rewrites every flat Post Embed in both tables into one message, exactly', async () => {
        await migrateOrThrow(migrator.migrateTo(BEFORE));
        await seedOldShape();
        vi.spyOn(console, 'warn').mockImplementation(() => undefined);

        await migrateOrThrow(migrator.migrateToLatest());

        expect(await storedText()).toEqual({ flow: JSON.stringify(FLOW_GRAPH_UP), draft: JSON.stringify(DRAFT_GRAPH_UP) });
    });

    it('writes nodes the live schema takes, and leaves a refused link for the builder to mark', async () => {
        await migrateOrThrow(migrator.migrateTo(BEFORE));
        await seedOldShape();
        vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        await migrateOrThrow(migrator.migrateToLatest());

        const { flow } = await storedGraphs();
        const complete = flow.nodes.filter((candidate) => ['complete', 'tokens', 'already'].includes(candidate.id));
        expect(complete).toHaveLength(3);
        expect(validateNodeData(graphOf(complete))).toEqual({ valid: true });

        const refused = validateNodeData(graphOf(flow.nodes.filter((candidate) => candidate.id === 'refused')));
        expect(refused.valid).toBe(false);
        if (!refused.valid) {
            expect(refused.issues.map((issue) => issue.field)).toEqual(['message.embeds.0.url', 'message.embeds.0.image']);
        }

        // The migration's title-link rule agrees with the live schema's: what it logged, the schema refuses.
        const unparseable = validateNodeData(graphOf(flow.nodes.filter((candidate) => candidate.id === 'unparseable')));
        expect(unparseable.valid).toBe(false);
        if (!unparseable.valid) {
            expect(unparseable.issues.map((issue) => issue.field)).toEqual(['message.embeds.0.url']);
        }
    });

    it('logs each link the new rules refuse, naming the flow, draft, node and part', async () => {
        await migrateOrThrow(migrator.migrateTo(BEFORE));
        await seedOldShape();
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

        await migrateOrThrow(migrator.migrateToLatest());

        const logged = warn.mock.calls.map((call) => String(call[0]));
        expect(logged).toHaveLength(4);
        expect(logged[0]).toMatch(/flow flow-mixed, node refused: its title link "https:\/\/example\.com\/a b"/);
        expect(logged[1]).toMatch(/flow flow-mixed, node refused: its image "https:\/\/example\.com\/my pic\.png"/);
        expect(logged[2]).toMatch(/flow flow-mixed, node unparseable: its title link "https:\/\/a%zz\/x"/);
        expect(logged[3]).toMatch(/flow flow-mixed draft \d+, node draft-post: its image "https:\/\/example\.com\/draft pic\.png"/);
    });

    it('is a no-op when run again', async () => {
        await migrateOrThrow(migrator.migrateTo(BEFORE));
        await seedOldShape();
        vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        await migrateOrThrow(migrator.migrateToLatest());
        const before = await storedText();

        await postEmbedMessageShape(database);

        expect(await storedText()).toEqual(before);
    });

    it('goes down to embed 0 in flat keys, losing what they cannot hold, and back up', async () => {
        await migrateOrThrow(migrator.migrateTo(BEFORE));
        await seedOldShape();
        vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        await migrateOrThrow(migrator.migrateToLatest());

        await migrateOrThrow(migrator.migrateTo(BEFORE));

        const down = await storedGraphs();
        expect(dataOf(down.flow, 'complete')).toEqual({
            channelId: CHANNEL,
            legacyNote: 'kept',
            title: 'House Rules',
            description: 'Read them.',
            color: '#00A2FF',
            url: 'https://example.com/rules',
            authorName: 'The Management',
            fields: UP.complete.message.embeds[0].fields,
            imageUrl: 'https://example.com/banner.png',
            thumbnailUrl: 'https://example.com/icon.png',
            footerText: 'Behave yourselves.',
            showTimestamp: 'true',
        });
        // Plain text, the second embed, the footer's icon and both uploads have nowhere to go.
        expect(dataOf(down.flow, 'already')).toEqual({
            channelId: CHANNEL,
            title: 'Already',
            fields: [],
            footerText: 'f',
            showTimestamp: 'false',
        });
        expect(dataOf(down.flow, 'sidecar')).toEqual({ ...OLD.sidecar, fields: [] });
        expect(dataOf(down.flow, 'say')).toEqual(SEND_MESSAGE);

        await migrateOrThrow(migrator.migrateToLatest());

        // Back up, every node is as the first run left it — but the one `down` cut short.
        const again = await storedGraphs();
        expect(again.draft).toEqual(DRAFT_GRAPH_UP);
        expect(again.flow).toEqual({
            ...FLOW_GRAPH_UP,
            nodes: FLOW_GRAPH_UP.nodes.map((candidate) =>
                candidate.id === 'already'
                    ? {
                          ...candidate,
                          data: {
                              channelId: CHANNEL,
                              message: { embeds: [{ title: 'Already', fields: [], footer: { text: 'f' }, timestamp: false }] },
                          },
                      }
                    : candidate
            ),
        });
    });
});
