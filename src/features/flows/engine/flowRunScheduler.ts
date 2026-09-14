import type { Client } from 'discord.js';
import { FLOW_RUN_POLL_INTERVAL_MS } from '../constants';
import { FlowRunsRepo, flowRunsRepo } from '../data/flowRunsRepo';
import { RESUME_TIMEOUT } from '../blocks/types';
import { resumeFlowRun } from './flowRunResume';

export type FlowRunSchedulerDependencies = {
    flowRunsRepo: Pick<FlowRunsRepo, 'findDue' | 'reclaimAbandonedClaims'>;
};

const defaultDependencies: FlowRunSchedulerDependencies = {
    flowRunsRepo,
};

let flowRunInterval: ReturnType<typeof setInterval> | null = null;
let isTickRunning = false;

/**
 * Start polling for durable flow runs whose `wakeAt` has passed.
 *
 * A sweep runs immediately on start, not just after the first interval, so delays
 * that elapsed while the bot was down fire as soon as it is back up. That sweep
 * first reclaims every resume claim left over from an earlier process — a run left
 * at `running` by a SIGKILL matches neither parked-run query, so nothing else would
 * ever find it.
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

    void runStartupSweep(client, dependencies).catch((error: unknown) => {
        console.error('[flow-runs] Startup sweep failed:', error);
    });
}

/**
 * Reclaim abandoned claims, then resume anything already due.
 *
 * The order is load-bearing: a run stranded at `running` by a killed process
 * matches neither parked-run query, so it only becomes visible to `findDue` once
 * its claim has been handed back.
 */
async function runStartupSweep(client: Client, dependencies: FlowRunSchedulerDependencies): Promise<void> {
    await reclaimStrandedFlowRuns(dependencies);
    await runFlowRunTick(client, dependencies);
}

/**
 * Hand back resume claims left behind by a process that died holding them.
 *
 * Startup only. See {@link FlowRunsRepo.reclaimAbandonedClaims} for why that
 * timing is what makes reclaiming *every* outstanding claim safe, and what would
 * have to change first before this could run on a timer.
 */
export async function reclaimStrandedFlowRuns(
    dependencies: FlowRunSchedulerDependencies = defaultDependencies
): Promise<number> {
    try {
        const reclaimed = await dependencies.flowRunsRepo.reclaimAbandonedClaims();
        if (reclaimed > 0) {
            console.warn(
                `[flow-runs] Reclaimed ${reclaimed} stranded run claim(s) left behind by an earlier process`
            );
        }
        return reclaimed;
    } catch (error) {
        if (isMissingFlowRunsTableError(error)) {
            // The tick that follows reports this once, with the fix.
            return 0;
        }
        // Recovery is off for the life of this process now, so this has to be loud.
        // A half-applied migration lands here, not in the branch above.
        console.error(
            '[flow-runs] Could not reclaim stranded run claims, so a run stranded by an ' +
                'earlier process will not resume until the next restart:',
            error
        );
        return 0;
    }
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
                const outcome = await resumeFlowRun(client, run, RESUME_TIMEOUT);
                if (outcome.status === 'failed') {
                    console.warn(`[flow-runs] Run ${run.runId} failed on resume: ${outcome.error}`);
                }
            } catch (error) {
                console.error(`[flow-runs] Unexpected error resuming run ${run.runId}:`, error);
            }
        }
    } catch (error) {
        if (isMissingFlowRunsTableError(error)) {
            // Almost always an un-migrated database rather than a real fault, and
            // the tick repeats every 15s — so say what to do instead of dumping a
            // stack trace on a loop.
            console.error(
                '[flow-runs] The flow_runs table does not exist. Run `pnpm migrate:latest:dev` ' +
                    '(or `pnpm migrate:latest`) to apply pending migrations.'
            );
            return;
        }
        console.error('[flow-runs] Tick failed while looking for due runs:', error);
    } finally {
        isTickRunning = false;
    }
}

/**
 * True only for "the `flow_runs` table is not there" from SQLite or Postgres —
 * i.e. the schema has not been migrated yet.
 *
 * Deliberately requires the table name. A bare "does not exist" match would also
 * swallow a missing *column* from a half-applied migration, and this predicate
 * decides whether an error is reported at all.
 */
function isMissingFlowRunsTableError(error: unknown): boolean {
    if (!(error instanceof Error)) return false;
    const message = error.message.toLowerCase();
    if (!message.includes('flow_runs')) return false;
    return message.includes('no such table') || message.includes('does not exist');
}

export function resetFlowRunSchedulerForTests(): void {
    if (flowRunInterval) {
        clearInterval(flowRunInterval);
    }
    flowRunInterval = null;
    isTickRunning = false;
}
