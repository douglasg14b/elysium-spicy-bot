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
import { FlowsRepo, type AfterFlowWrite } from '../flowsRepo';

/**
 * Which flow writes tell `registerAfterWrite` callers — the hook the Message Sent trigger
 * index is dropped through. Every write that changes a flow row tells; one that writes
 * nothing to a flow does not.
 */

const EMPTY: FlowGraph = { version: FLOW_GRAPH_VERSION, nodes: [], edges: [] };

describe('FlowsRepo after-write callbacks (sqlite)', () => {
    let db: DatabaseClient;
    let repo: FlowsRepo;
    let told: ReturnType<typeof vi.fn<AfterFlowWrite>>;

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
        told = vi.fn<AfterFlowWrite>();
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

    it('tells on a create, naming the guild', async () => {
        await repo.create({ guildId: 'guild-1', name: 'Mouthy', graph: EMPTY });
        expect(told).toHaveBeenCalledTimes(1);
        expect(told).toHaveBeenCalledWith({ guildId: 'guild-1' });
    });

    it('tells on an update, as an install writing ids back makes — naming the guild it read back', async () => {
        const flowId = await created();
        await repo.update(flowId, { name: 'Renamed' });
        expect(told).toHaveBeenCalledTimes(1);
        expect(told).toHaveBeenCalledWith({ guildId: 'guild-1' });
    });

    it('tells on a written mutate — a save, or a switch on or off — naming the guild', async () => {
        const flowId = await created();
        await repo.mutate(flowId, () => ({ kind: 'write', input: { enabled: true } }));
        expect(told).toHaveBeenCalledTimes(1);
        expect(told).toHaveBeenCalledWith({ guildId: 'guild-1' });
    });

    it('awaits a callback that returns a promise before the write returns', async () => {
        let finished = false;
        repo.registerAfterWrite(async () => {
            await new Promise((resolve) => setTimeout(resolve, 10));
            finished = true;
        });

        await repo.create({ guildId: 'guild-1', name: 'Mouthy', graph: EMPTY });

        expect(finished).toBe(true);
    });

    it('logs a callback that rejects, still tells the rest, and the write still stands', async () => {
        const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const after = vi.fn<() => void>();
        repo.registerAfterWrite(() => Promise.reject(new Error('reconcile exploded')));
        repo.registerAfterWrite(after);

        const flow = await repo.create({ guildId: 'guild-1', name: 'Mouthy', graph: EMPTY });

        expect(after).toHaveBeenCalledTimes(1);
        expect(flow.name).toBe('Mouthy');
        expect(error).toHaveBeenCalledWith('[flows] A follow-up to a flow write failed:', expect.any(Error));
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

    it('tells on a delete, naming the guild the deleted flow was in', async () => {
        const flow = await repo.create({ guildId: 'guild-2', name: 'Doomed', graph: EMPTY });
        told.mockClear();

        await repo.deleteByFlowId(flow.flowId);

        expect(told).toHaveBeenCalledTimes(1);
        expect(told).toHaveBeenCalledWith({ guildId: 'guild-2' });
    });

    it('tells no one when a delete finds no flow', async () => {
        await repo.deleteByFlowId('no-such-flow');
        expect(told).not.toHaveBeenCalled();
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
