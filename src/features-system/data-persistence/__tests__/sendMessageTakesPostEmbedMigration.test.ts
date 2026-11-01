import { Migrator, sql } from 'kysely';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ensureBlocksDiscovered } from '../../../features/flows/blocks/registry';
import type { FlowGraph, FlowNode } from '../../../features/flows/data/flowGraph';
import { validateNodeData } from '../../../features/flows/engine/nodeDataValidation';
import { database } from '../database';
import { FileMigrationProvider } from '../fileMigrationProvider';
import { down as splitBlocks, up as sendMessageTakesPostEmbed } from '../migrations/2026-10-31-Send_Message_Takes_Post_Embed';
import { migrateTestDatabase } from './support/migrateTestDatabase';

/**
 * `2026-10-31-Send_Message_Takes_Post_Embed` on SQLite, through a real `Migrator` on the
 * production `database` stack — `CamelCasePlugin`, and `SqliteJsonPlugin` parsing both
 * `graph` columns — after the pattern of `postEmbedMessageShapeMigration.test.ts`.
 *
 * The old shape is seeded with raw SQL after migrating down to the migration before. The
 * stored text is read back under an alias the JSON plugin does not parse, so the exact
 * serialized output is what is pinned. Every complete node it writes is then held to the
 * **live** `validateNodeData`, which ties the transform frozen in the migration to the
 * block's schema today.
 *
 * Postgres is not covered here: CI runs SQLite only.
 */

const BEFORE = '2026-10-30-Create_Member_Names';
const CHANNEL = '1100000000000000001';
const UPLOAD = 'upload:0f0e0d0c-0b0a-4908-8706-050403020100';
const POST_EMBED = 'action.postEmbed';
const SEND_MESSAGE = 'action.sendMessage';

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

/** Each node as the two blocks stored it before the merge. */
const OLD = {
    embed: {
        where: 'here',
        channelId: CHANNEL,
        message: { content: 'Hi {{subject.mention}}', embeds: [{ title: 'House rules', thumbnail: UPLOAD }] },
        buttons: [{ key: 'kneel', label: 'Kneel', style: 'Primary' }],
    },
    embedTextOnly: { channelId: CHANNEL, message: { content: 'Just words.', embeds: [] } },
    say: { channelId: CHANNEL, message: 'Hello, {{subject.mention}}.' },
    whisper: { where: 'here', ephemeral: true, message: 'Only you, pet.' },
    blank: { channelId: CHANNEL, message: '' },
    // A node the builder already wrote in the new shape.
    already: { channelId: CHANNEL, message: { content: 'Already', embeds: [{ title: 'New' }] } },
    // Dropped fresh and never filled in.
    fresh: { where: 'channel' },
} as const;

const TRIGGER = node('trigger', 'trigger.buttonClick', { button: { messageKey: 'panel', buttonKey: 'go' } });

const FLOW_GRAPH = graphOf([
    TRIGGER,
    node('embed', POST_EMBED, OLD.embed),
    node('embed-text', POST_EMBED, OLD.embedTextOnly),
    node('say', SEND_MESSAGE, OLD.say),
    node('whisper', SEND_MESSAGE, OLD.whisper),
    node('blank', SEND_MESSAGE, OLD.blank),
    node('already', SEND_MESSAGE, OLD.already),
    node('fresh', SEND_MESSAGE, OLD.fresh),
]);

const DRAFT_GRAPH = graphOf([node('draft-embed', POST_EMBED, OLD.embed), node('draft-say', SEND_MESSAGE, OLD.say)]);

/** Each node's data once migrated up, exactly — key order included. */
const UP = {
    say: { channelId: CHANNEL, message: { content: 'Hello, {{subject.mention}}.', embeds: [] } },
    whisper: { where: 'here', ephemeral: true, message: { content: 'Only you, pet.', embeds: [] } },
    // Absent means left out: a message with neither, for the server to name.
    blank: { channelId: CHANNEL, message: { embeds: [] } },
} as const;

const FLOW_GRAPH_UP = graphOf([
    TRIGGER,
    node('embed', SEND_MESSAGE, OLD.embed),
    node('embed-text', SEND_MESSAGE, OLD.embedTextOnly),
    node('say', SEND_MESSAGE, UP.say),
    node('whisper', SEND_MESSAGE, UP.whisper),
    node('blank', SEND_MESSAGE, UP.blank),
    node('already', SEND_MESSAGE, OLD.already),
    node('fresh', SEND_MESSAGE, OLD.fresh),
]);

const DRAFT_GRAPH_UP = graphOf([node('draft-embed', SEND_MESSAGE, OLD.embed), node('draft-say', SEND_MESSAGE, UP.say)]);

async function seedOldShape(): Promise<void> {
    await sql`
        INSERT INTO flows (flow_id, guild_id, name, enabled, graph)
        VALUES ('flow-mixed', 'guild-1', 'Mixed', 0, ${JSON.stringify(FLOW_GRAPH)})
    `.execute(database);
    await sql`
        INSERT INTO flow_drafts (flow_id, guild_id, author_id, author_name, name, graph, base_updated_at)
        VALUES ('flow-mixed', 'guild-1', 'user-1', 'domme', 'Mixed', ${JSON.stringify(DRAFT_GRAPH)}, '2026-10-30T12:00:00.000Z')
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

function nodeOf(graph: FlowGraph, nodeId: string): FlowNode | undefined {
    return graph.nodes.find((candidate) => candidate.id === nodeId);
}

beforeAll(async () => {
    await ensureBlocksDiscovered();
    await migrateTestDatabase();
    // Block discovery imports every block; under a parallel run it has taken over 15s.
}, 60_000);

afterEach(async () => {
    // Every case leaves the schema at latest and the tables empty, whatever it did.
    await migrateOrThrow(migrator.migrateToLatest());
    await clearSeeds();
});

describe('2026-10-31-Send_Message_Takes_Post_Embed (sqlite, through Migrator)', () => {
    it('turns every Post Embed into a Send Message and every string message into an object, in both tables, exactly', async () => {
        await migrateOrThrow(migrator.migrateTo(BEFORE));
        await seedOldShape();

        await migrateOrThrow(migrator.migrateToLatest());

        expect(await storedText()).toEqual({ flow: JSON.stringify(FLOW_GRAPH_UP), draft: JSON.stringify(DRAFT_GRAPH_UP) });
    });

    it('writes nodes the live Send Message takes, and leaves an emptied message for the builder to mark', async () => {
        await migrateOrThrow(migrator.migrateTo(BEFORE));
        await seedOldShape();
        await migrateOrThrow(migrator.migrateToLatest());

        const { flow, draft } = await storedGraphs();
        const complete = flow.nodes.filter((candidate) => ['embed', 'embed-text', 'say', 'whisper', 'already'].includes(candidate.id));
        expect(complete).toHaveLength(5);
        expect(validateNodeData(graphOf(complete))).toEqual({ valid: true });
        expect(validateNodeData(graphOf(draft.nodes))).toEqual({ valid: true });

        const blank = validateNodeData(graphOf(flow.nodes.filter((candidate) => candidate.id === 'blank')));
        expect(blank.valid).toBe(false);
        if (!blank.valid) {
            expect(blank.issues.map((issue) => issue.field)).toEqual(['message']);
        }
    });

    it('is a no-op when run again', async () => {
        await migrateOrThrow(migrator.migrateTo(BEFORE));
        await seedOldShape();
        await migrateOrThrow(migrator.migrateToLatest());
        const before = await storedText();

        await sendMessageTakesPostEmbed(database);

        expect(await storedText()).toEqual(before);
    });

    it('goes down to a string for plain text alone and to a Post Embed for anything more, losing ephemeral, and back up', async () => {
        await migrateOrThrow(migrator.migrateTo(BEFORE));
        await seedOldShape();
        await migrateOrThrow(migrator.migrateToLatest());

        await migrateOrThrow(migrator.migrateTo(BEFORE));

        const down = await storedGraphs();
        expect(nodeOf(down.flow, 'say')).toEqual(node('say', SEND_MESSAGE, OLD.say));
        expect(nodeOf(down.flow, 'whisper')).toEqual(node('whisper', SEND_MESSAGE, OLD.whisper));
        expect(nodeOf(down.flow, 'blank')).toEqual(node('blank', SEND_MESSAGE, OLD.blank));
        expect(nodeOf(down.flow, 'embed')).toEqual(node('embed', POST_EMBED, OLD.embed));
        // Plain text alone, so it cannot be told from a Send Message once merged.
        expect(nodeOf(down.flow, 'embed-text')).toEqual(node('embed-text', SEND_MESSAGE, { channelId: CHANNEL, message: 'Just words.' }));
        expect(nodeOf(down.flow, 'already')).toEqual(node('already', POST_EMBED, OLD.already));
        expect(nodeOf(down.flow, 'fresh')).toEqual(node('fresh', SEND_MESSAGE, OLD.fresh));
        expect(down.draft).toEqual(DRAFT_GRAPH);

        await migrateOrThrow(migrator.migrateToLatest());

        // Back up, every node is as the first run left it — but the one `down` turned into a string.
        const again = await storedGraphs();
        expect(again.draft).toEqual(DRAFT_GRAPH_UP);
        expect(again.flow).toEqual({
            ...FLOW_GRAPH_UP,
            nodes: FLOW_GRAPH_UP.nodes.map((candidate) =>
                candidate.id === 'embed-text'
                    ? { ...candidate, data: { channelId: CHANNEL, message: { content: 'Just words.', embeds: [] } } }
                    : candidate
            ),
        });
    });

    it('drops ephemeral from a private answer with an embed on the way down, and buttons only when there are none', async () => {
        await migrateOrThrow(migrator.migrateTo(BEFORE));
        await sql`
            INSERT INTO flows (flow_id, guild_id, name, enabled, graph)
            VALUES ('flow-private', 'guild-1', 'Private', 0, ${JSON.stringify(
                graphOf([
                    node('private-embed', SEND_MESSAGE, {
                        where: 'here',
                        ephemeral: true,
                        message: { content: 'Look.', embeds: [{ title: 'Only you' }] },
                    }),
                    node('empty-buttons', SEND_MESSAGE, { channelId: CHANNEL, message: 'Hi', buttons: [] }),
                ])
            )})
        `.execute(database);
        await migrateOrThrow(migrator.migrateToLatest());

        await splitBlocks(database);

        const { rows } = await sql<{ serialized: string }>`SELECT graph AS serialized FROM flows`.execute(database);
        const graph = JSON.parse(rows[0]?.serialized ?? '') as FlowGraph;
        expect(nodeOf(graph, 'private-embed')).toEqual(
            node('private-embed', POST_EMBED, { where: 'here', message: { content: 'Look.', embeds: [{ title: 'Only you' }] } })
        );
        expect(nodeOf(graph, 'empty-buttons')).toEqual(node('empty-buttons', SEND_MESSAGE, { channelId: CHANNEL, message: 'Hi' }));

        // Down twice changes nothing more.
        const once = rows[0]?.serialized;
        await splitBlocks(database);
        const twice = await sql<{ serialized: string }>`SELECT graph AS serialized FROM flows`.execute(database);
        expect(twice.rows[0]?.serialized).toBe(once);

        // Put the schema's record back in step with the data for the next case.
        await sendMessageTakesPostEmbed(database);
    });
});
