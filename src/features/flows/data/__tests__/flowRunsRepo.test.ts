import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import SqliteDatabase from 'better-sqlite3';
import { CamelCasePlugin, Kysely, SqliteDialect, sql } from 'kysely';
import type { Database, DatabaseClient } from '../../../../features-system/data-persistence/database';
import { SqlDatePlugin } from '../../../../features-system/data-persistence/plugins/sqlDatePlugin';
import { SqliteBindingPlugin } from '../../../../features-system/data-persistence/plugins/sqliteBindingPlugin';
import { SqliteJsonPlugin } from '../../../../features-system/data-persistence/plugins/sqliteJsonPlugin';
import { FlowRunsRepo } from '../flowRunsRepo';

const GUILD_ID = 'guild-1';
const USER_ID = 'user-1';

describe('FlowRunsRepo (sqlite)', () => {
    const sqlite = new SqliteDatabase(':memory:');
    const db = new Kysely<Database>({
        dialect: new SqliteDialect({ database: async () => sqlite }),
        plugins: [
            new SqliteBindingPlugin<Database>({}),
            new SqliteJsonPlugin<Database>({
                flow_runs: ['waitConfig', 'contextSnapshot', 'log'],
            }),
            new CamelCasePlugin(),
            new SqlDatePlugin<Database>({ flow_runs: ['wakeAt', 'createdAt', 'updatedAt'] }),
        ],
    }) as DatabaseClient;

    const repo = new FlowRunsRepo(db);

    beforeAll(async () => {
        await sql`
            CREATE TABLE flow_runs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                run_id TEXT NOT NULL,
                flow_id TEXT NOT NULL,
                guild_id TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'pending',
                resume_node_id TEXT,
                wake_at TEXT,
                wait_kind TEXT,
                wait_config TEXT,
                context_snapshot TEXT NOT NULL,
                visits_used INTEGER NOT NULL DEFAULT 0,
                log TEXT NOT NULL,
                error TEXT,
                entity_version INTEGER NOT NULL DEFAULT 1,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )
        `.execute(db);
        await sql`CREATE UNIQUE INDEX flow_runs_run_id_unique_idx ON flow_runs (run_id)`.execute(db);
    });

    beforeEach(async () => {
        await sql`DELETE FROM flow_runs`.execute(db);
    });

    afterAll(async () => {
        await db.destroy();
    });

    it('round-trips a suspended run through the JSON and date columns', async () => {
        const wakeAt = new Date(Date.now() + 60_000);

        const created = await repo.create({
            flowId: 'flow-1',
            guildId: GUILD_ID,
            contextSnapshot: { guildId: GUILD_ID, userId: USER_ID },
            resumeNodeId: 'dm',
            wakeAt,
            visitsUsed: 3,
            log: [{ nodeId: 'trigger', type: 'trigger.buttonClick', kind: 'trigger', status: 'ok' }],
        });

        expect(created.status).toBe('pending');
        expect(created.contextSnapshot).toEqual({ guildId: GUILD_ID, userId: USER_ID });
        expect(created.visitsUsed).toBe(3);
        expect(created.log).toHaveLength(1);
        expect(created.wakeAt?.toISOString()).toBe(wakeAt.toISOString());
        expect(created.waitConfig).toBeNull();

        const fetched = await repo.getByRunId(created.runId);
        expect(fetched?.log[0]?.nodeId).toBe('trigger');
    });

    it('findDue picks up an overdue run and not a future one', async () => {
        const now = new Date();

        const overdue = await repo.create({
            flowId: 'flow-overdue',
            guildId: GUILD_ID,
            contextSnapshot: { guildId: GUILD_ID, userId: USER_ID },
            resumeNodeId: 'dm',
            wakeAt: new Date(now.getTime() - 60_000),
        });

        await repo.create({
            flowId: 'flow-future',
            guildId: GUILD_ID,
            contextSnapshot: { guildId: GUILD_ID, userId: USER_ID },
            resumeNodeId: 'dm',
            wakeAt: new Date(now.getTime() + 60 * 60_000),
        });

        // A run parked on an event with no timeout must never be "due".
        await repo.create({
            flowId: 'flow-waiting',
            guildId: GUILD_ID,
            contextSnapshot: { guildId: GUILD_ID, userId: USER_ID },
            resumeNodeId: 'wait',
            wakeAt: null,
            waitKind: 'memberJoin',
            waitConfig: { eventKind: 'memberJoin' },
        });

        const due = await repo.findDue(now);

        expect(due).toHaveLength(1);
        expect(due[0]?.runId).toBe(overdue.runId);
    });

    it('findDue ignores runs that are no longer pending', async () => {
        const now = new Date();
        const run = await repo.create({
            flowId: 'flow-1',
            guildId: GUILD_ID,
            contextSnapshot: { guildId: GUILD_ID, userId: USER_ID },
            resumeNodeId: 'dm',
            wakeAt: new Date(now.getTime() - 60_000),
        });

        await repo.complete(run.runId);

        expect(await repo.findDue(now)).toHaveLength(0);
    });

    it('findWaiting returns only pending event-parked runs, filtered by guild and kind', async () => {
        const waiting = await repo.create({
            flowId: 'flow-wait',
            guildId: GUILD_ID,
            contextSnapshot: { guildId: GUILD_ID, userId: USER_ID },
            resumeNodeId: 'wait',
            waitKind: 'memberJoin',
            waitConfig: { eventKind: 'memberJoin', timeoutMs: 60_000 },
        });

        // A plain delay — no waitKind, so it must not show up.
        await repo.create({
            flowId: 'flow-delay',
            guildId: GUILD_ID,
            contextSnapshot: { guildId: GUILD_ID, userId: USER_ID },
            resumeNodeId: 'dm',
            wakeAt: new Date(),
        });

        // Right kind, wrong guild.
        await repo.create({
            flowId: 'flow-other-guild',
            guildId: 'guild-2',
            contextSnapshot: { guildId: 'guild-2', userId: USER_ID },
            resumeNodeId: 'wait',
            waitKind: 'memberJoin',
            waitConfig: { eventKind: 'memberJoin' },
        });

        const found = await repo.findWaiting({ guildId: GUILD_ID, waitKind: 'memberJoin' });

        expect(found).toHaveLength(1);
        expect(found[0]?.runId).toBe(waiting.runId);
        expect(found[0]?.waitConfig).toEqual({ eventKind: 'memberJoin', timeoutMs: 60_000 });
    });

    it('complete, fail and cancel clear the wake/wait fields so a run is never re-picked', async () => {
        const base = {
            guildId: GUILD_ID,
            contextSnapshot: { guildId: GUILD_ID, userId: USER_ID },
            resumeNodeId: 'wait',
            wakeAt: new Date(Date.now() - 1000),
            waitKind: 'memberJoin' as const,
            waitConfig: { eventKind: 'memberJoin' as const },
        };

        const completed = await repo.complete((await repo.create({ ...base, flowId: 'f1' })).runId);
        const failed = await repo.fail((await repo.create({ ...base, flowId: 'f2' })).runId, 'boom');
        const cancelled = await repo.cancel((await repo.create({ ...base, flowId: 'f3' })).runId, 'flow deleted');

        for (const row of [completed, failed, cancelled]) {
            expect(row.wakeAt).toBeNull();
            expect(row.waitKind).toBeNull();
            expect(row.waitConfig).toBeNull();
            expect(row.resumeNodeId).toBeNull();
        }

        expect(completed.status).toBe('completed');
        expect(failed.status).toBe('failed');
        expect(failed.error).toBe('boom');
        expect(cancelled.status).toBe('cancelled');
        expect(await repo.findDue(new Date())).toHaveLength(0);
        expect(await repo.findWaiting({ guildId: GUILD_ID })).toHaveLength(0);
    });

    it('rejects a row whose stored contextSnapshot is corrupt', async () => {
        const run = await repo.create({
            flowId: 'flow-1',
            guildId: GUILD_ID,
            contextSnapshot: { guildId: GUILD_ID, userId: USER_ID },
            resumeNodeId: 'dm',
        });

        await sql`UPDATE flow_runs SET context_snapshot = ${'{"guildId":"g"}'} WHERE run_id = ${run.runId}`.execute(
            db
        );

        await expect(repo.getByRunId(run.runId)).rejects.toThrow(/invalid stored contextSnapshot/i);
    });

    it('update patches visitsUsed and the log across a resume', async () => {
        const run = await repo.create({
            flowId: 'flow-1',
            guildId: GUILD_ID,
            contextSnapshot: { guildId: GUILD_ID, userId: USER_ID },
            resumeNodeId: 'delay',
            visitsUsed: 3,
        });

        const patched = await repo.update(run.runId, {
            visitsUsed: 7,
            resumeNodeId: 'dm',
            log: [{ nodeId: 'delay', type: 'action.delay', kind: 'action', status: 'ok' }],
        });

        expect(patched.visitsUsed).toBe(7);
        expect(patched.resumeNodeId).toBe('dm');
        expect(patched.log).toHaveLength(1);
    });
});
