import SqliteDatabase from 'better-sqlite3';
import { CamelCasePlugin, Kysely, SqliteDialect } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Database, DatabaseClient } from '../../../../features-system/data-persistence/database';
import { up as createFlows } from '../../../../features-system/data-persistence/migrations/2026-09-11-Create_Flows';
import { up as createFlowDrafts } from '../../../../features-system/data-persistence/migrations/2026-09-29-Create_Flow_Drafts';
import { SqlDatePlugin } from '../../../../features-system/data-persistence/plugins/sqlDatePlugin';
import { SqliteBindingPlugin } from '../../../../features-system/data-persistence/plugins/sqliteBindingPlugin';
import { SqliteJsonPlugin } from '../../../../features-system/data-persistence/plugins/sqliteJsonPlugin';
import { FLOW_GRAPH_VERSION, type FlowGraph } from '../flowGraph';
import { FlowDraftsRepo, type FlowDraftInput } from '../flowDraftsRepo';
import { FlowsRepo } from '../flowsRepo';

/**
 * Drafts against real sqlite, built by the real migrations — so the unique index the
 * upsert leans on is the one production has, not a copy of it.
 *
 * The plugin stack is `database.ts`'s for these two tables. A fake that dropped
 * `baseUpdatedAt` or skipped the index would pass the cases that matter most here.
 */

const EMPTY: FlowGraph = { version: FLOW_GRAPH_VERSION, nodes: [], edges: [] };
const ONE_NODE: FlowGraph = {
    version: FLOW_GRAPH_VERSION,
    nodes: [{ id: 'dm', type: 'action.sendDM', position: { x: 0, y: 0 }, data: { message: '' } }],
    edges: [],
};

describe('FlowDraftsRepo (sqlite)', () => {
    let db: DatabaseClient;
    let drafts: FlowDraftsRepo;
    let flows: FlowsRepo;

    beforeEach(async () => {
        const sqlite = new SqliteDatabase(':memory:');
        db = new Kysely<Database>({
            dialect: new SqliteDialect({ database: async () => sqlite }),
            plugins: [
                new SqliteBindingPlugin<Database>({ flows: ['enabled'] }),
                new SqliteJsonPlugin<Database>({ flows: ['graph'], flow_drafts: ['graph'] }),
                new CamelCasePlugin(),
                new SqlDatePlugin<Database>({
                    flows: ['createdAt', 'updatedAt'],
                    flow_drafts: ['baseUpdatedAt', 'createdAt', 'updatedAt'],
                }),
            ],
        }) as DatabaseClient;
        await createFlows(db);
        await createFlowDrafts(db);
        drafts = new FlowDraftsRepo(db);
        flows = new FlowsRepo(db);
    });

    afterEach(async () => {
        await db.destroy();
    });

    const mine = (overrides: Partial<FlowDraftInput> = {}): FlowDraftInput => ({
        flowId: 'flow-1',
        guildId: 'guild-1',
        authorId: 'alice',
        authorName: 'alice',
        name: 'Greeter',
        graph: EMPTY,
        baseUpdatedAt: '2026-09-29T10:00:00.000Z',
        ...overrides,
    });

    it('replaces the author’s draft in place, base included', async () => {
        const first = await drafts.upsertMine(mine());
        // Same author, new content descending from a newer flow — they kept the saved
        // version over their old draft and edited it. The base describes what is stored
        // now; the old one would warn "saved since" about a save this canvas contains.
        const second = await drafts.upsertMine(
            mine({ name: 'Greeter v2', graph: ONE_NODE, authorName: 'alice-renamed', baseUpdatedAt: '2026-09-29T11:00:00.000Z' })
        );

        expect(second.id).toBe(first.id);
        expect(second).toMatchObject({ name: 'Greeter v2', graph: ONE_NODE, authorName: 'alice-renamed' });
        expect(new Date(second.baseUpdatedAt).toISOString()).toBe('2026-09-29T11:00:00.000Z');
        expect(new Date(second.createdAt).getTime()).toBe(new Date(first.createdAt).getTime());
        expect(await drafts.listByFlowId('flow-1')).toHaveLength(1);
    });

    it('holds one draft per author per flow, and lists every author’s', async () => {
        await drafts.upsertMine(mine());
        await drafts.upsertMine(mine({ authorId: 'bob', authorName: 'bob' }));
        await drafts.upsertMine(mine({ flowId: 'flow-2' }));

        const listed = await drafts.listByFlowId('flow-1');
        expect(listed.map((draft) => draft.authorId).sort()).toEqual(['alice', 'bob']);
    });

    it('stores an incomplete graph and refuses a structurally broken one', async () => {
        // Incomplete is what drafts are for: the DM has no message.
        await expect(drafts.upsertMine(mine({ graph: ONE_NODE }))).resolves.toMatchObject({ graph: ONE_NODE });

        const dangling: FlowGraph = { ...EMPTY, edges: [{ id: 'e', source: 'nowhere', target: 'nothing' }] };
        await expect(drafts.upsertMine(mine({ authorId: 'bob', graph: dangling }))).rejects.toThrow(/invalid graph/);
    });

    it('deletes a draft by id only within its own flow', async () => {
        const other = await drafts.upsertMine(mine({ flowId: 'flow-2' }));

        // The id is real, but it belongs to another flow's draft.
        expect(await drafts.deleteById('flow-1', other.id)).toBe(false);
        expect(await drafts.listByFlowId('flow-2')).toHaveLength(1);

        expect(await drafts.deleteById('flow-2', other.id)).toBe(true);
        expect(await drafts.listByFlowId('flow-2')).toEqual([]);
    });

    it('deletes one author’s draft and leaves the others', async () => {
        await drafts.upsertMine(mine());
        await drafts.upsertMine(mine({ authorId: 'bob', authorName: 'bob' }));

        await drafts.deleteByAuthor('flow-1', 'alice');

        expect((await drafts.listByFlowId('flow-1')).map((draft) => draft.authorId)).toEqual(['bob']);
    });

    it('goes with its flow when the flow is deleted, and no other flow’s does', async () => {
        const flow = await flows.create({ guildId: 'guild-1', name: 'Greeter', graph: EMPTY });
        const kept = await flows.create({ guildId: 'guild-1', name: 'Other', graph: EMPTY });
        await drafts.upsertMine(mine({ flowId: flow.flowId }));
        await drafts.upsertMine(mine({ flowId: kept.flowId }));

        await flows.deleteByFlowId(flow.flowId);

        expect(await drafts.listByFlowId(flow.flowId)).toEqual([]);
        expect(await drafts.listByFlowId(kept.flowId)).toHaveLength(1);
    });

    describe('through FlowsRepo.mutate', () => {
        it('keeps a draft beside the flow without touching it, in the flow’s guild', async () => {
            const flow = await flows.create({ guildId: 'guild-1', name: 'Greeter', graph: EMPTY, enabled: true });
            const loadedAt = new Date(flow.updatedAt).toISOString();

            const outcome = await flows.mutate(flow.flowId, () => ({
                kind: 'draft',
                draft: { authorId: 'alice', authorName: 'alice', name: 'Renamed', graph: ONE_NODE, baseUpdatedAt: loadedAt },
            }));

            expect(outcome.kind).toBe('drafted');
            const stored = await flows.getByFlowId(flow.flowId);
            expect(stored).toMatchObject({ name: 'Greeter', graph: EMPTY, enabled: true });
            expect(new Date(stored!.updatedAt).getTime()).toBe(new Date(flow.updatedAt).getTime());

            const [draft] = await drafts.listByFlowId(flow.flowId);
            expect(draft).toMatchObject({ name: 'Renamed', graph: ONE_NODE, guildId: 'guild-1' });
            expect(new Date(draft!.baseUpdatedAt).toISOString()).toBe(loadedAt);
        });

        it('discards only the named author’s draft when a write supersedes it', async () => {
            const flow = await flows.create({ guildId: 'guild-1', name: 'Greeter', graph: EMPTY });
            await drafts.upsertMine(mine({ flowId: flow.flowId }));
            await drafts.upsertMine(mine({ flowId: flow.flowId, authorId: 'bob', authorName: 'bob' }));

            await flows.mutate(flow.flowId, () => ({
                kind: 'write',
                input: { graph: ONE_NODE },
                discardDraftOf: 'alice',
            }));

            expect((await drafts.listByFlowId(flow.flowId)).map((draft) => draft.authorId)).toEqual(['bob']);
        });

        it('leaves every draft alone on a write that supersedes nobody’s', async () => {
            const flow = await flows.create({ guildId: 'guild-1', name: 'Greeter', graph: EMPTY });
            await drafts.upsertMine(mine({ flowId: flow.flowId }));

            await flows.mutate(flow.flowId, () => ({ kind: 'write', input: { enabled: true } }));

            expect(await drafts.listByFlowId(flow.flowId)).toHaveLength(1);
        });
    });
});
