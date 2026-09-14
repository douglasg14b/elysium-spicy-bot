import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import type { DatabaseClient } from '../../../../features-system/data-persistence/database';
import { createFlowRunsTestDb } from '../../../../features-system/data-persistence/__tests__/support/flowRunsTestDb';
import { IllegalFlowRunTransitionError } from '../flowRunLifecycle';
import { FlowRunsRepo } from '../flowRunsRepo';

const GUILD_ID = 'guild-1';
const USER_ID = 'user-1';

describe('FlowRunsRepo (sqlite)', () => {
    let db: DatabaseClient;
    let repo: FlowRunsRepo;

    beforeAll(async () => {
        // The schema comes from the real migrations, so this suite cannot pass
        // against a table shape production does not have.
        ({ db } = await createFlowRunsTestDb());
        repo = new FlowRunsRepo(db);
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

        expect(created.status).toBe('suspended');
        expect(created.claimedAt).toBeNull();
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

    it('findDue ignores a run that is no longer suspended', async () => {
        const now = new Date();
        const run = await repo.create({
            flowId: 'flow-1',
            guildId: GUILD_ID,
            contextSnapshot: { guildId: GUILD_ID, userId: USER_ID },
            resumeNodeId: 'dm',
            wakeAt: new Date(now.getTime() - 60_000),
        });

        await repo.claimForResume(run.runId);
        await repo.complete(run.runId);

        expect(await repo.findDue(now)).toHaveLength(0);
    });

    it('findDue ignores a run that is currently claimed', async () => {
        const now = new Date();
        const run = await repo.create({
            flowId: 'flow-1',
            guildId: GUILD_ID,
            contextSnapshot: { guildId: GUILD_ID, userId: USER_ID },
            resumeNodeId: 'dm',
            wakeAt: new Date(now.getTime() - 60_000),
        });

        await repo.claimForResume(run.runId);

        // Still due by `wakeAt`, but someone is already resuming it.
        expect(await repo.findDue(now)).toHaveLength(0);
    });

    it('findWaiting returns only suspended event-parked runs, filtered by guild and kind', async () => {
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

        /** Create a run and claim it, the way a resumer reaches a terminal state. */
        const claimedRun = async (flowId: string): Promise<string> => {
            const { runId } = await repo.create({ ...base, flowId });
            await repo.claimForResume(runId);
            return runId;
        };

        const completed = await repo.complete(await claimedRun('f1'));
        const failed = await repo.fail(await claimedRun('f2'), 'boom');
        // Cancelling is the operator's move, so it is legal straight off a parked
        // run — nobody has to claim a run to call it off.
        const cancelled = await repo.cancel((await repo.create({ ...base, flowId: 'f3' })).runId, 'flow deleted');

        for (const row of [completed, failed, cancelled]) {
            expect(row.wakeAt).toBeNull();
            expect(row.waitKind).toBeNull();
            expect(row.waitConfig).toBeNull();
            expect(row.resumeNodeId).toBeNull();
            expect(row.claimedAt).toBeNull();
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

    it('carries visitsUsed and the log forward across a resume', async () => {
        const run = await repo.create({
            flowId: 'flow-1',
            guildId: GUILD_ID,
            contextSnapshot: { guildId: GUILD_ID, userId: USER_ID },
            resumeNodeId: 'delay',
            visitsUsed: 3,
        });
        await repo.claimForResume(run.runId);

        const patched = await repo.park(run.runId, {
            visitsUsed: 7,
            resumeNodeId: 'dm',
            log: [{ nodeId: 'delay', type: 'action.delay', kind: 'action', status: 'ok' }],
            variables: {},
        });

        expect(patched.visitsUsed).toBe(7);
        expect(patched.resumeNodeId).toBe('dm');
        expect(patched.log).toHaveLength(1);
    });

    describe('the resume claim', () => {
        /** A parked run, due a minute ago. */
        const parkedRun = async (flowId = 'flow-1'): Promise<string> => {
            const run = await repo.create({
                flowId,
                guildId: GUILD_ID,
                contextSnapshot: { guildId: GUILD_ID, userId: USER_ID },
                resumeNodeId: 'dm',
                wakeAt: new Date(Date.now() - 60_000),
                visitsUsed: 2,
            });
            return run.runId;
        };

        it('claims a suspended run, stamping when the claim was taken', async () => {
            const runId = await parkedRun();
            const before = Date.now();

            const claimed = await repo.claimForResume(runId);

            expect(claimed?.status).toBe('running');
            expect(claimed?.claimedAt?.getTime()).toBeGreaterThanOrEqual(before - 1000);
            // The claimed row carries the run's real state, not a stale copy.
            expect(claimed?.resumeNodeId).toBe('dm');
            expect(claimed?.visitsUsed).toBe(2);
        });

        it('lets exactly one of two simultaneous resumers win, and the loser quietly loses', async () => {
            const runId = await parkedRun();

            const [first, second] = await Promise.all([
                repo.claimForResume(runId),
                repo.claimForResume(runId),
            ]);

            const winners = [first, second].filter((claim) => claim !== null);
            expect(winners).toHaveLength(1);
            expect(winners[0]?.status).toBe('running');
        });

        it('releases a claim without disturbing where the run is parked', async () => {
            const runId = await parkedRun();
            const claimed = await repo.claimForResume(runId);

            const released = await repo.releaseClaim(runId);

            expect(released?.status).toBe('suspended');
            expect(released?.claimedAt).toBeNull();
            expect(released?.resumeNodeId).toBe(claimed?.resumeNodeId);
            expect(released?.wakeAt?.toISOString()).toBe(claimed?.wakeAt?.toISOString());
            expect(released?.visitsUsed).toBe(claimed?.visitsUsed);
            // Back in the pool, so the very next poll picks it up again.
            expect(await repo.findDue(new Date())).toHaveLength(1);
        });

        it('parks a claimed run again, clearing the claim and moving the resume point', async () => {
            const runId = await parkedRun();
            await repo.claimForResume(runId);

            const parked = await repo.park(runId, {
                resumeNodeId: 'wait',
                waitKind: 'memberJoin',
                waitConfig: { eventKind: 'memberJoin' },
                visitsUsed: 9,
                log: [{ nodeId: 'delay', type: 'action.delay', kind: 'action', status: 'ok' }],
                variables: {},
            });

            expect(parked.status).toBe('suspended');
            expect(parked.claimedAt).toBeNull();
            expect(parked.resumeNodeId).toBe('wait');
            expect(parked.wakeAt).toBeNull();
            expect(parked.visitsUsed).toBe(9);
            expect(await repo.findWaiting({ guildId: GUILD_ID })).toHaveLength(1);
        });

        it('reclaims a claim however recently it was taken', async () => {
            // The regression this pins: a crash seconds after a claim is the common
            // case, so an age threshold would skip exactly the run that needs help.
            const runId = await parkedRun();
            await repo.claimForResume(runId);

            expect(await repo.reclaimAbandonedClaims()).toBe(1);

            const reclaimed = await repo.getByRunId(runId);
            expect(reclaimed?.status).toBe('suspended');
            expect(reclaimed?.claimedAt).toBeNull();
            // Visible to the poller again, which is the whole point.
            expect(await repo.findDue(new Date())).toHaveLength(1);
        });

        it('reclaims every outstanding claim and leaves parked and finished runs alone', async () => {
            const firstClaimed = await parkedRun('flow-a');
            const secondClaimed = await parkedRun('flow-b');
            const stillParked = await parkedRun('flow-c');
            const finished = await parkedRun('flow-d');
            await repo.claimForResume(firstClaimed);
            await repo.claimForResume(secondClaimed);
            await repo.claimForResume(finished);
            await repo.complete(finished);

            expect(await repo.reclaimAbandonedClaims()).toBe(2);

            expect((await repo.getByRunId(firstClaimed))?.status).toBe('suspended');
            expect((await repo.getByRunId(secondClaimed))?.status).toBe('suspended');
            expect((await repo.getByRunId(stillParked))?.status).toBe('suspended');
            expect((await repo.getByRunId(finished))?.status).toBe('completed');
        });

        it('reclaims a running row with no claim stamp at all, which is only ever a bug', async () => {
            const runId = await parkedRun();
            await repo.claimForResume(runId);
            await sql`UPDATE flow_runs SET claimed_at = NULL WHERE run_id = ${runId}`.execute(db);

            expect(await repo.reclaimAbandonedClaims()).toBe(1);
            expect((await repo.getByRunId(runId))?.status).toBe('suspended');
        });

        it('reclaims nothing when no claim is outstanding', async () => {
            await parkedRun();

            expect(await repo.reclaimAbandonedClaims()).toBe(0);
        });

        it('refuses to complete a run nobody claimed, rather than silently overwriting it', async () => {
            const runId = await parkedRun();

            await expect(repo.complete(runId)).rejects.toThrow(IllegalFlowRunTransitionError);
            // The run is untouched, so the poller will still find it.
            expect((await repo.getByRunId(runId))?.status).toBe('suspended');
        });

        it('names the run when a lifecycle write targets a row that does not exist', async () => {
            await expect(repo.complete('run-that-never-was')).rejects.toThrow(/run-that-never-was/);
        });

        it('does not claim a run that has already finished', async () => {
            const runId = await parkedRun();
            await repo.claimForResume(runId);
            await repo.complete(runId);

            expect(await repo.claimForResume(runId)).toBeNull();
        });
    });
});
