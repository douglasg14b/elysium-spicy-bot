import SqliteDatabase from 'better-sqlite3';
import { CamelCasePlugin, Kysely, SqliteDialect } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database, DatabaseClient } from '../../../../features-system/data-persistence/database';
import { up as createFlows } from '../../../../features-system/data-persistence/migrations/2026-09-11-Create_Flows';
import { up as createFlowDrafts } from '../../../../features-system/data-persistence/migrations/2026-09-29-Create_Flow_Drafts';
import { SqlDatePlugin } from '../../../../features-system/data-persistence/plugins/sqlDatePlugin';
import { SqliteBindingPlugin } from '../../../../features-system/data-persistence/plugins/sqliteBindingPlugin';
import { SqliteJsonPlugin } from '../../../../features-system/data-persistence/plugins/sqliteJsonPlugin';
import { FLOW_GRAPH_VERSION, type FlowGraph } from '../flowGraph';
import { FlowsRepo } from '../flowsRepo';

/**
 * Which flow writes tell `registerAfterWrite` callers — the hook the Message Sent trigger
 * index is dropped through. Every write that changes a flow row tells; one that writes
 * nothing to a flow does not.
 */

const EMPTY: FlowGraph = { version: FLOW_GRAPH_VERSION, nodes: [], edges: [] };

describe('FlowsRepo after-write callbacks (sqlite)', () => {
    let db: DatabaseClient;
    let repo: FlowsRepo;
    let told: ReturnType<typeof vi.fn<() => void>>;

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
        repo = new FlowsRepo(db);
        told = vi.fn<() => void>();
        repo.registerAfterWrite(told);
    });

    afterEach(async () => {
        await db.destroy();
    });

    async function created(): Promise<string> {
        const flow = await repo.create({ guildId: 'guild-1', name: 'Mouthy', graph: EMPTY });
        told.mockClear();
        return flow.flowId;
    }

    it('tells on a create', async () => {
        await repo.create({ guildId: 'guild-1', name: 'Mouthy', graph: EMPTY });
        expect(told).toHaveBeenCalledTimes(1);
    });

    it('tells on an update, as an install writing ids back makes', async () => {
        const flowId = await created();
        await repo.update(flowId, { name: 'Renamed' });
        expect(told).toHaveBeenCalledTimes(1);
    });

    it('tells on a written mutate — a save, or a switch on or off', async () => {
        const flowId = await created();
        await repo.mutate(flowId, () => ({ kind: 'write', input: { enabled: true } }));
        expect(told).toHaveBeenCalledTimes(1);
    });

    it('stays quiet when a mutate keeps a draft, refuses, or finds nothing', async () => {
        const flowId = await created();

        await repo.mutate(flowId, () => ({
            kind: 'draft',
            draft: { authorId: 'alice', authorName: 'alice', name: 'Mouthy', graph: EMPTY, baseUpdatedAt: new Date().toISOString() },
        }));
        await repo.mutate(flowId, () => ({ kind: 'refuse', refusal: 'no' }));
        await repo.mutate('no-such-flow', () => ({ kind: 'write', input: { enabled: true } }));

        expect(told).not.toHaveBeenCalled();
    });

    it('tells on a delete', async () => {
        const flowId = await created();
        await repo.deleteByFlowId(flowId);
        expect(told).toHaveBeenCalledTimes(1);
    });

    it('still tells the rest when one callback throws, and the write still stands', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const after = vi.fn<() => void>();
        repo.registerAfterWrite(() => {
            throw new Error('index exploded');
        });
        repo.registerAfterWrite(after);

        const flow = await repo.create({ guildId: 'guild-1', name: 'Mouthy', graph: EMPTY });

        expect(after).toHaveBeenCalledTimes(1);
        expect(flow.name).toBe('Mouthy');
    });
});
