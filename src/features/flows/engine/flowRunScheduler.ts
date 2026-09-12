import type { Client } from 'discord.js';
import { FLOW_RUN_POLL_INTERVAL_MS } from '../constants';
import { FlowRunsRepo, flowRunsRepo } from '../data/flowRunsRepo';
import { resumeFlowRun } from './flowRunResume';

export type FlowRunSchedulerDependencies = {
    flowRunsRepo: Pick<FlowRunsRepo, 'findDue'>;
};

const defaultDependencies: FlowRunSchedulerDependencies = {
    flowRunsRepo,
};

let flowRunInterval: ReturnType<typeof setInterval> | null = null;
let isTickRunning = false;

/**
 * Start polling for durable flow runs whose `wakeAt` has passed.
 *
 * A sweep runs immediately on start, not just after the first interval, so
 * delays that elapsed while the bot was down fire as soon as it is back up.
 */
export function startFlowRunScheduler(
    client: Client,
    intervalMs: number = FLOW_RUN_POLL_INTERVAL_MS,
    dependencies: FlowRunSchedulerDependencies = defaultDependencies
): void {
    if (flowRunInterval) {
        return;
    }

    flowRunInterval = setInterval(() => {
        void runFlowRunTick(client, dependencies);
    }, intervalMs);

    console.info(`[flow-runs] Scheduler started with interval ${intervalMs}ms`);

    // Catch-up sweep for anything that came due while the bot was offline.
    void runFlowRunTick(client, dependencies);
}

export function stopFlowRunScheduler(): void {
    if (!flowRunInterval) {
        return;
    }

    clearInterval(flowRunInterval);
    flowRunInterval = null;
    console.info('[flow-runs] Scheduler stopped');
}

/**
 * One poll: resume every run whose `wakeAt` has passed. Errors are isolated per
 * run so one bad flow cannot stall the queue.
 *
 * A due run parked on a wait node has hit its timeout, hence the 'timeout' exit;
 * a due run parked on a delay ignores the exit entirely.
 */
export async function runFlowRunTick(
    client: Client,
    dependencies: FlowRunSchedulerDependencies = defaultDependencies
): Promise<void> {
    if (isTickRunning) {
        console.info('[flow-runs] Skipping tick because previous tick is still running');
        return;
    }

    if (!client.user) {
        console.info('[flow-runs] Skipping tick because Discord client user is not ready yet');
        return;
    }

    isTickRunning = true;

    try {
        const dueRuns = await dependencies.flowRunsRepo.findDue(new Date());
        if (dueRuns.length === 0) {
            return;
        }

        console.info(`[flow-runs] Resuming ${dueRuns.length} due run(s)`);

        for (const run of dueRuns) {
            try {
                const outcome = await resumeFlowRun(client, run, 'timeout');
                if (outcome.status === 'failed') {
                    console.warn(`[flow-runs] Run ${run.runId} failed on resume: ${outcome.error}`);
                }
            } catch (error) {
                console.error(`[flow-runs] Unexpected error resuming run ${run.runId}:`, error);
            }
        }
    } catch (error) {
        console.error('[flow-runs] Tick failed while looking for due runs:', error);
    } finally {
        isTickRunning = false;
    }
}

export function resetFlowRunSchedulerForTests(): void {
    if (flowRunInterval) {
        clearInterval(flowRunInterval);
    }
    flowRunInterval = null;
    isTickRunning = false;
}
