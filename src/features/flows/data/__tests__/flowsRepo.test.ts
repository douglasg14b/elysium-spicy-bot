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
        const { graph } = buildOnboardingFlowGraph({ memberRoleId: 'role-1', welcomeMessage: 'hi' });

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
        const { graph } = buildOnboardingFlowGraph({ memberRoleId: 'role-1', welcomeMessage: 'hi' });
        // Introduce a back-edge to make it cyclic.
        graph.edges.push({ id: 'back', source: graph.nodes[2].id, target: graph.nodes[0].id });

        const created = await repo.create({ guildId: 'guild-2', name: 'Looping', graph });
        expect(created.graph.edges).toHaveLength(graph.edges.length);

        // And it round-trips back out (reads re-validate too).
        const fetched = await repo.getByFlowId(created.flowId);
        expect(fetched?.graph.edges.some((edge) => edge.id === 'back')).toBe(true);
    });
});
