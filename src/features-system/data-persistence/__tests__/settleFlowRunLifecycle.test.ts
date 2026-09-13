import { sql } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseClient } from '../database';
import {
    createFlowRunsTestClient,
    insertPreM1FlowRunRow,
    type FlowRunsTestDb,
} from './support/flowRunsTestDb';
import { up as createFlowRuns } from '../migrations/2026-09-12-Create_Flow_Runs';
import { down, up } from '../migrations/2026-09-13-Settle_Flow_Run_Lifecycle';

const PARKED_RUN_ID = 'run-parked-before-m1';
const FINISHED_RUN_ID = 'run-finished-before-m1';

/** A pre-M1 row parked on a wait, in the status the old code would have written. */
function preM1Row(runId: string, status: string) {
    return {
        run_id: runId,
        flow_id: 'flow-1',
        guild_id: 'guild-1',
        status,
        resume_node_id: 'wait',
        wake_at: '2026-09-01T00:00:00.000Z',
        wait_kind: 'memberJoin',
        wait_config: '{"eventKind":"memberJoin","timeoutMs":60000}',
        context_snapshot: '{"guildId":"guild-1","userId":"user-1"}',
        visits_used: 4,
        log: '[]',
        error: null,
        entity_version: 1,
        created_at: '2026-09-01T00:00:00.000Z',
        updated_at: '2026-09-01T00:00:00.000Z',
    };
}

async function readStatus(db: DatabaseClient, runId: string): Promise<string> {
    const row = await db.selectFrom('flow_runs').select('status').where('runId', '=', runId).executeTakeFirst();
    return row?.status ?? 'missing';
}

/**
 * The run-status rename is the one M1 change that rewrites live data, so it is
 * tested in both directions rather than assumed. Nothing else in this repository
 * runs a migration under test, which is exactly why this one is worth pinning.
 */
describe('2026-09-13-Settle_Flow_Run_Lifecycle (sqlite)', () => {
    let testDb: FlowRunsTestDb;

    beforeEach(async () => {
        testDb = createFlowRunsTestClient();
        // The pre-M1 table: `status` defaults to 'pending' and there is no claim column.
        await createFlowRuns(testDb.db);
        await insertPreM1FlowRunRow(testDb.db, preM1Row(PARKED_RUN_ID, 'pending'));
        await insertPreM1FlowRunRow(testDb.db, preM1Row(FINISHED_RUN_ID, 'completed'));
    });

    afterEach(async () => {
        await testDb.db.destroy();
    });

    it('sorts after the migration that created the table', () => {
        // The provider keys on filename and Kysely refuses to run an executed
        // migration that is out of position, so ordering is load-bearing.
        expect('2026-09-13-Settle_Flow_Run_Lifecycle' > '2026-09-12-Create_Flow_Runs').toBe(true);
    });

    it('rewrites a parked run to suspended and leaves a finished one alone', async () => {
        await up(testDb.db);

        expect(await readStatus(testDb.db, PARKED_RUN_ID)).toBe('suspended');
        expect(await readStatus(testDb.db, FINISHED_RUN_ID)).toBe('completed');
    });

    it('preserves everything a parked run needs in order to resume', async () => {
        await up(testDb.db);

        const row = await testDb.db
            .selectFrom('flow_runs')
            .selectAll()
            .where('runId', '=', PARKED_RUN_ID)
            .executeTakeFirst();

        expect(row?.resumeNodeId).toBe('wait');
        expect(row?.waitKind).toBe('memberJoin');
        expect(row?.waitConfig).toEqual({ eventKind: 'memberJoin', timeoutMs: 60_000 });
        expect(row?.visitsUsed).toBe(4);
        expect(row?.entityVersion).toBe(1);
        // Nobody holds a claim on a run that was parked before claims existed.
        expect(row?.claimedAt).toBeNull();
    });

    it('reverses cleanly, putting a suspended or claimed run back to pending', async () => {
        await up(testDb.db);
        await sql`UPDATE flow_runs SET status = 'running', claimed_at = '2026-09-13T00:00:00.000Z'
                  WHERE run_id = ${PARKED_RUN_ID}`.execute(testDb.db);

        await down(testDb.db);

        expect(await readStatus(testDb.db, PARKED_RUN_ID)).toBe('pending');
        expect(await readStatus(testDb.db, FINISHED_RUN_ID)).toBe('completed');
        await expect(
            sql`SELECT claimed_at FROM flow_runs`.execute(testDb.db)
        ).rejects.toThrow(/claimed_at/i);
    });
});
