import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import SqliteDatabase from 'better-sqlite3';
import { CamelCasePlugin, Kysely, SqliteDialect, sql } from 'kysely';
import type { Database, DatabaseClient } from '../../../../features-system/data-persistence/database';
import { SqlDatePlugin } from '../../../../features-system/data-persistence/plugins/sqlDatePlugin';
import { SqliteBindingPlugin } from '../../../../features-system/data-persistence/plugins/sqliteBindingPlugin';
import { SqliteJsonPlugin } from '../../../../features-system/data-persistence/plugins/sqliteJsonPlugin';
import { FlowsRepo } from '../flowsRepo';
import { buildOnboardingFlowGraph } from '../../templates/onboardingFlow';

describe('FlowsRepo (sqlite)', () => {
    const sqlite = new SqliteDatabase(':memory:');
    const db = new Kysely<Database>({
        dialect: new SqliteDialect({ database: async () => sqlite }),
        plugins: [
            new SqliteBindingPlugin<Database>({ flows: ['enabled'] }),
            new SqliteJsonPlugin<Database>({ flows: ['graph'] }),
            new CamelCasePlugin(),
            new SqlDatePlugin<Database>({ flows: ['createdAt', 'updatedAt'] }),
        ],
    }) as DatabaseClient;

    const repo = new FlowsRepo(db);

    beforeAll(async () => {
        // No block discovery: the repo checks structure only, which reads no block
        // declarations. A write that needed the registry here would be a repo that
        // had started judging readiness again.
        await sql`
            CREATE TABLE flows (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                flow_id TEXT NOT NULL,
                guild_id TEXT NOT NULL,
                name TEXT NOT NULL,
                enabled INTEGER NOT NULL DEFAULT 0,
                graph TEXT NOT NULL,
                entity_version INTEGER NOT NULL DEFAULT 1,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )
        `.execute(db);
        await sql`CREATE UNIQUE INDEX flows_flow_id_unique_idx ON flows (flow_id)`.execute(db);
    });

    afterAll(async () => {
        await db.destroy();
    });

    it('round-trips a flow graph through the JSON column', async () => {
        const { graph } = buildOnboardingFlowGraph({ memberRoleId: 'role-1', channelId: 'channel-1', welcomeMessage: 'hi' });

        const created = await repo.create({ guildId: 'guild-1', name: 'Onboarding', graph, enabled: true });
        expect(created.guildId).toBe('guild-1');
        expect(created.enabled).toBe(true);
        expect(created.graph.nodes).toHaveLength(3);

        const fetched = await repo.getByFlowId(created.flowId);
        expect(fetched?.graph).toEqual(graph);

        const list = await repo.getByGuildId('guild-1');
        expect(list).toHaveLength(1);

        const disabled = await repo.setEnabled(created.flowId, false);
        expect(disabled.enabled).toBe(false);
    });

    it('accepts a cyclic graph — loops are legal since Phase 5', async () => {
        const { graph } = buildOnboardingFlowGraph({ memberRoleId: 'role-1', channelId: 'channel-1', welcomeMessage: 'hi' });
        // Introduce a back-edge to make it cyclic.
        graph.edges.push({ id: 'back', source: graph.nodes[2].id, target: graph.nodes[0].id });

        const created = await repo.create({ guildId: 'guild-2', name: 'Looping', graph });
        expect(created.graph.edges).toHaveLength(graph.edges.length);

        // And it round-trips back out (reads re-validate too).
        const fetched = await repo.getByFlowId(created.flowId);
        expect(fetched?.graph.edges.some((edge) => edge.id === 'back')).toBe(true);
    });

    it('stores an incomplete graph — structure is the only thing a write refuses', async () => {
        // Whether an incomplete flow may go *live* is decided where it is switched on;
        // refusing to store one is how an operator lost a canvas to one empty field.
        const { graph } = buildOnboardingFlowGraph({ memberRoleId: 'role-1', channelId: 'channel-1', welcomeMessage: 'hi' });
        const created = await repo.create({ guildId: 'guild-3', name: 'Half done', graph });

        const incomplete = structuredClone(graph);
        // A second edge on one handle is the authoring rule the repo used to refuse, so
        // it is what makes this case able to fail. The emptied config rides along as
        // the other kind of incomplete; the repo never checked node data even before.
        incomplete.nodes[1].data = {};
        incomplete.edges.push({ id: 'fan-out', source: graph.nodes[0].id, target: graph.nodes[2].id });

        const updated = await repo.update(created.flowId, { graph: incomplete });
        expect(updated.graph).toEqual(incomplete);
        expect((await repo.getByFlowId(created.flowId))?.graph).toEqual(incomplete);
    });

    it('still refuses a graph whose edges name nodes that are not there', async () => {
        const { graph } = buildOnboardingFlowGraph({ memberRoleId: 'role-1', channelId: 'channel-1', welcomeMessage: 'hi' });
        const created = await repo.create({ guildId: 'guild-4', name: 'Dangling', graph });

        const broken = structuredClone(graph);
        broken.edges.push({ id: 'dangling', source: graph.nodes[0].id, target: 'nowhere' });

        await expect(repo.update(created.flowId, { graph: broken })).rejects.toThrow(/unknown target node/);
        expect((await repo.getByFlowId(created.flowId))?.graph).toEqual(graph);
    });

    describe('mutate', () => {
        const onboarding = () =>
            buildOnboardingFlowGraph({ memberRoleId: 'role-1', channelId: 'channel-1', welcomeMessage: 'hi' }).graph;

        it('writes what `check` chose, and passes a refusal back without writing', async () => {
            const created = await repo.create({ guildId: 'guild-5', name: 'Decided', graph: onboarding() });

            const refused = await repo.mutate(created.flowId, () => ({ kind: 'refuse', refusal: 'nope' }));
            expect(refused).toEqual({ kind: 'refused', refusal: 'nope' });
            expect((await repo.getByFlowId(created.flowId))?.enabled).toBe(false);

            const written = await repo.mutate(created.flowId, () => ({ kind: 'write', input: { enabled: true } }));
            expect(written.kind === 'written' && written.flow.enabled).toBe(true);

            expect(await repo.mutate('no-such-flow', () => ({ kind: 'write', input: {} }))).toEqual({ kind: 'missing' });
        });

        /*
         * The reason `mutate` exists. Two writers each allowed by the row they saw — one
         * stores an unfinished graph because the flow is off, one switches it on because
         * its graph is finished — must not both land, or the flow ends up live and
         * unfinished. Node count stands in for readiness here: three is the finished
         * graph, four the unfinished one. Run as a get-then-update, both read the same
         * starting row and both write.
         */
        it('decides each of two concurrent writers against the row the other left', async () => {
            const created = await repo.create({ guildId: 'guild-6', name: 'Contended', graph: onboarding() });
            const unfinished = structuredClone(created.graph);
            unfinished.nodes.push({ id: 'extra', type: 'action.sendDM', position: { x: 0, y: 0 }, data: {} });

            await Promise.all([
                repo.mutate(created.flowId, (current) =>
                    current.enabled
                        ? { kind: 'refuse', refusal: 'live' }
                        : { kind: 'write', input: { graph: unfinished } }
                ),
                repo.mutate(created.flowId, (current) =>
                    current.graph.nodes.length === 3
                        ? { kind: 'write', input: { enabled: true } }
                        : { kind: 'refuse', refusal: 'unfinished' }
                ),
            ]);

            const final = await repo.getByFlowId(created.flowId);
            expect(final?.enabled && final.graph.nodes.length === 4).toBe(false);
        });
    });
});
