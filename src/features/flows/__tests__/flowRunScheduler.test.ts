import type { Client } from 'discord.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FlowRunEntity } from '../data/flowRunsSchema';

const resumeFlowRun = vi.fn();

vi.mock('../engine/flowRunResume', () => ({
    resumeFlowRun: (...args: unknown[]) => resumeFlowRun(...args),
}));

const {
    runFlowRunTick,
    startFlowRunScheduler,
    stopFlowRunScheduler,
    reclaimStrandedFlowRuns,
    resetFlowRunSchedulerForTests,
} = await import('../engine/flowRunScheduler');

const GUILD_ID = 'guild-1';

function makeRun(runId: string): FlowRunEntity {
    return {
        id: 1,
        runId,
        flowId: 'flow-1',
        guildId: GUILD_ID,
        status: 'suspended',
        claimedAt: null,
        resumeNodeId: 'dm',
        wakeAt: new Date(Date.now() - 1000),
        waitKind: null,
        waitConfig: null,
        contextSnapshot: { guildId: GUILD_ID, userId: 'user-1' },
        visitsUsed: 1,
        log: [],
        error: null,
        entityVersion: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
    } as FlowRunEntity;
}

const READY_CLIENT = { user: { id: 'bot-1' } } as unknown as Client;

/** Scheduler dependencies with the reclaim sweep stubbed to "nothing stranded". */
function makeDeps(findDue: ReturnType<typeof vi.fn>, reclaimAbandonedClaims = vi.fn().mockResolvedValue(0)) {
    return { flowRunsRepo: { findDue, reclaimAbandonedClaims } };
}

describe('flow run scheduler', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        resetFlowRunSchedulerForTests();
        resumeFlowRun.mockResolvedValue({ status: 'completed' });
    });

    afterEach(() => {
        resetFlowRunSchedulerForTests();
    });

    it('resumes every due run on a tick, with the timeout exit', async () => {
        const findDue = vi.fn().mockResolvedValue([makeRun('run-1'), makeRun('run-2')]);

        await runFlowRunTick(READY_CLIENT, makeDeps(findDue));

        expect(resumeFlowRun).toHaveBeenCalledTimes(2);
        expect(resumeFlowRun).toHaveBeenCalledWith(READY_CLIENT, expect.anything(), 'timeout');
    });

    it('skips the tick until the client is ready', async () => {
        const findDue = vi.fn().mockResolvedValue([makeRun('run-1')]);

        await runFlowRunTick({} as Client, makeDeps(findDue));

        expect(findDue).not.toHaveBeenCalled();
    });

    it('isolates a failing run so the rest of the batch still resumes', async () => {
        const findDue = vi.fn().mockResolvedValue([makeRun('run-1'), makeRun('run-2')]);
        resumeFlowRun.mockRejectedValueOnce(new Error('boom'));

        await expect(runFlowRunTick(READY_CLIENT, makeDeps(findDue))).resolves.toBeUndefined();
        expect(resumeFlowRun).toHaveBeenCalledTimes(2);
    });

    it('does not throw when the due-run lookup fails', async () => {
        const findDue = vi.fn().mockRejectedValue(new Error('db down'));

        await expect(runFlowRunTick(READY_CLIENT, makeDeps(findDue))).resolves.toBeUndefined();
    });

    it('sweeps immediately on start so delays that elapsed while down fire at once', async () => {
        const findDue = vi.fn().mockResolvedValue([makeRun('run-overdue')]);

        // No timers are advanced — the sweep must happen on the start call itself.
        startFlowRunScheduler(READY_CLIENT, 60 * 60_000, makeDeps(findDue));

        await vi.waitFor(() => {
            expect(findDue).toHaveBeenCalledTimes(1);
            expect(resumeFlowRun).toHaveBeenCalledTimes(1);
        });

        stopFlowRunScheduler();
    });

    it('reclaims stranded claims before the first catch-up sweep', async () => {
        // A run stranded at `running` only becomes visible to `findDue` once its
        // claim is handed back, so the order here is the whole point.
        const callOrder: string[] = [];
        const reclaimAbandonedClaims = vi.fn(async () => {
            callOrder.push('reclaim');
            return 1;
        });
        const findDue = vi.fn(async () => {
            callOrder.push('findDue');
            return [makeRun('run-stranded')];
        });

        startFlowRunScheduler(READY_CLIENT, 60 * 60_000, makeDeps(findDue, reclaimAbandonedClaims));

        await vi.waitFor(() => {
            expect(resumeFlowRun).toHaveBeenCalledTimes(1);
        });

        expect(callOrder).toEqual(['reclaim', 'findDue']);
        stopFlowRunScheduler();
    });

    it('still sweeps for due runs when the reclaim itself fails', async () => {
        const reclaimAbandonedClaims = vi.fn().mockRejectedValue(new Error('db down'));
        const findDue = vi.fn().mockResolvedValue([makeRun('run-due')]);

        startFlowRunScheduler(READY_CLIENT, 60 * 60_000, makeDeps(findDue, reclaimAbandonedClaims));

        await vi.waitFor(() => {
            expect(resumeFlowRun).toHaveBeenCalledTimes(1);
        });

        stopFlowRunScheduler();
    });

    it('reports loudly when the reclaim fails for any reason but a missing table', async () => {
        // Recovery is off for the life of the process once this fails, so silence
        // would hide a stranded run indefinitely.
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const reclaimAbandonedClaims = vi.fn().mockRejectedValue(new Error('column "claimed_at" does not exist'));

        try {
            expect(await reclaimStrandedFlowRuns(makeDeps(vi.fn(), reclaimAbandonedClaims))).toBe(0);
            expect(consoleError).toHaveBeenCalledWith(
                expect.stringContaining('Could not reclaim stranded run claims'),
                expect.anything()
            );
        } finally {
            consoleError.mockRestore();
        }
    });

    it('stays quiet about an un-migrated database, which the tick reports with the fix', async () => {
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const reclaimAbandonedClaims = vi
            .fn()
            .mockRejectedValue(new Error('no such table: flow_runs'));

        try {
            expect(await reclaimStrandedFlowRuns(makeDeps(vi.fn(), reclaimAbandonedClaims))).toBe(0);
            expect(consoleError).not.toHaveBeenCalled();
        } finally {
            consoleError.mockRestore();
        }
    });

    it('asks for every outstanding claim, with no staleness window to wait out', async () => {
        const reclaimAbandonedClaims = vi.fn().mockResolvedValue(0);

        await reclaimStrandedFlowRuns(makeDeps(vi.fn(), reclaimAbandonedClaims));

        expect(reclaimAbandonedClaims).toHaveBeenCalledTimes(1);
        expect(reclaimAbandonedClaims).toHaveBeenCalledWith();
    });

    it('start is idempotent and stop clears the interval', () => {
        const findDue = vi.fn().mockResolvedValue([]);
        const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
        const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');

        try {
            startFlowRunScheduler(READY_CLIENT, 60 * 60_000, makeDeps(findDue));
            startFlowRunScheduler(READY_CLIENT, 60 * 60_000, makeDeps(findDue));
            expect(setIntervalSpy).toHaveBeenCalledTimes(1);

            stopFlowRunScheduler();
            expect(clearIntervalSpy).toHaveBeenCalledTimes(1);

            // A second stop is a no-op.
            stopFlowRunScheduler();
            expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
        } finally {
            setIntervalSpy.mockRestore();
            clearIntervalSpy.mockRestore();
            resetFlowRunSchedulerForTests();
        }
    });
});
