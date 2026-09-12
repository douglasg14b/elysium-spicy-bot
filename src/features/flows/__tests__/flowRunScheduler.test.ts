import type { Client } from 'discord.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FlowRunEntity } from '../data/flowRunsSchema';

const resumeFlowRun = vi.fn();

vi.mock('../engine/flowRunResume', () => ({
    resumeFlowRun: (...args: unknown[]) => resumeFlowRun(...args),
}));

const { runFlowRunTick, startFlowRunScheduler, stopFlowRunScheduler, resetFlowRunSchedulerForTests } =
    await import('../engine/flowRunScheduler');

const GUILD_ID = 'guild-1';

function makeRun(runId: string): FlowRunEntity {
    return {
        id: 1,
        runId,
        flowId: 'flow-1',
        guildId: GUILD_ID,
        status: 'pending',
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

        await runFlowRunTick(READY_CLIENT, { flowRunsRepo: { findDue } });

        expect(resumeFlowRun).toHaveBeenCalledTimes(2);
        expect(resumeFlowRun).toHaveBeenCalledWith(READY_CLIENT, expect.anything(), 'timeout');
    });

    it('skips the tick until the client is ready', async () => {
        const findDue = vi.fn().mockResolvedValue([makeRun('run-1')]);

        await runFlowRunTick({} as Client, { flowRunsRepo: { findDue } });

        expect(findDue).not.toHaveBeenCalled();
    });

    it('isolates a failing run so the rest of the batch still resumes', async () => {
        const findDue = vi.fn().mockResolvedValue([makeRun('run-1'), makeRun('run-2')]);
        resumeFlowRun.mockRejectedValueOnce(new Error('boom'));

        await expect(runFlowRunTick(READY_CLIENT, { flowRunsRepo: { findDue } })).resolves.toBeUndefined();
        expect(resumeFlowRun).toHaveBeenCalledTimes(2);
    });

    it('does not throw when the due-run lookup fails', async () => {
        const findDue = vi.fn().mockRejectedValue(new Error('db down'));

        await expect(runFlowRunTick(READY_CLIENT, { flowRunsRepo: { findDue } })).resolves.toBeUndefined();
    });

    it('sweeps immediately on start so delays that elapsed while down fire at once', async () => {
        const findDue = vi.fn().mockResolvedValue([makeRun('run-overdue')]);

        // No timers are advanced — the sweep must happen on the start call itself.
        startFlowRunScheduler(READY_CLIENT, 60 * 60_000, { flowRunsRepo: { findDue } });

        await vi.waitFor(() => {
            expect(findDue).toHaveBeenCalledTimes(1);
            expect(resumeFlowRun).toHaveBeenCalledTimes(1);
        });

        stopFlowRunScheduler();
    });

    it('start is idempotent and stop clears the interval', () => {
        const findDue = vi.fn().mockResolvedValue([]);
        const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
        const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');

        try {
            startFlowRunScheduler(READY_CLIENT, 60 * 60_000, { flowRunsRepo: { findDue } });
            startFlowRunScheduler(READY_CLIENT, 60 * 60_000, { flowRunsRepo: { findDue } });
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
