import type { Client } from 'discord.js';
import {
    type ActivityEventsRepo,
    activityEventsRepo,
    isBackfillPending,
    whenBackfillFinished,
} from '../../../features-system/activity';
import { FLOW_RUN_POLL_INTERVAL_MS } from '../constants';
import { FlowRunsRepo, flowRunsRepo } from '../data/flowRunsRepo';
import type { FlowRunEntity } from '../data/flowRunsSchema';
import { RESUME_TIMEOUT } from '../blocks/types';
import { failParkedRun, resumeFlowRun } from './flowRunResume';
import { rebuildMessageWaitIndex, resumeMessageWaitsAfterBackfill } from './messageWaitDispatch';

export type FlowRunSchedulerDependencies = {
    flowRunsRepo: Pick<FlowRunsRepo, 'findDue' | 'reclaimAbandonedClaims' | 'deferWake' | 'findWaiting'>;
    /**
     * Where a quiet-window park asks when the last qualifying message was sent, and a
     * message wait whether its member replied while the bot was down.
     */
    activityEventsRepo: Pick<ActivityEventsRepo, 'findLastMessageAt' | 'findLastMessageBetween'>;
    /** True while activity is still restoring messages missed during an outage; quiet-window runs wait. */
    isBackfillPending: () => boolean;
    /** Call back once activity's startup backfill is over, however it ended — straight away if it already is. */
    afterBackfill: (callback: () => void) => void;
};

const defaultDependencies: FlowRunSchedulerDependencies = {
    flowRunsRepo,
    activityEventsRepo,
    isBackfillPending,
    afterBackfill: whenBackfillFinished,
};

let flowRunInterval: ReturnType<typeof setInterval> | null = null;
let isTickRunning = false;

/**
 * True from the moment the scheduler starts until the outage catch-up has looked for
 * every message wait's reply. While it is, due message waits are held — not fetched,
 * not timed out — because a reply the catch-up has yet to find would have woken them
 * by their event exit.
 *
 * Raised by {@link startFlowRunScheduler} itself rather than by the sweep, so no tick
 * can ever run ahead of it.
 */
let messageWaitsHeld = false;

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

    messageWaitsHeld = true;
    flowRunInterval = setInterval(() => {
        void runFlowRunTick(client, dependencies);
    }, intervalMs);

    console.info(`[flow-runs] Scheduler started with interval ${intervalMs}ms`);

    void runStartupSweep(client, dependencies).catch((error: unknown) => {
        console.error('[flow-runs] Startup sweep failed:', error);
    });
}

/**
 * Reclaim abandoned claims, load the message-wait index, arrange the outage catch-up,
 * then resume anything already due.
 *
 * The order is load-bearing. A run stranded at `running` by a killed process matches
 * neither parked-run query, so it only becomes visible to `findDue` — and to the index
 * rebuild — once its claim has been handed back. And the catch-up is arranged only once
 * the index is loaded, because it reads its runs from there; it starts looking from each
 * run's park, so a message that arrived live before the index existed is found too.
 */
async function runStartupSweep(client: Client, dependencies: FlowRunSchedulerDependencies): Promise<void> {
    try {
        await reclaimStrandedFlowRuns(dependencies);
        await rebuildMessageWaitIndex(dependencies.flowRunsRepo);
    } finally {
        // Arranged however the steps above went: the catch-up is what lifts the hold on
        // message waits, and without it they would never time out in this process.
        dependencies.afterBackfill(() => {
            void resumeMessageWaitsAndRelease(client, dependencies);
        });
    }
    await runFlowRunTick(client, dependencies);
}

/**
 * Run the outage catch-up for message waits, then lift the hold on them however it
 * went. The catch-up logs each run's failure itself; the `catch` is for one that fails
 * outright, whose runs are then left to their time limits rather than held forever.
 */
async function resumeMessageWaitsAndRelease(
    client: Client,
    dependencies: FlowRunSchedulerDependencies
): Promise<void> {
    try {
        await resumeMessageWaitsAfterBackfill(client, dependencies.activityEventsRepo);
    } catch (error) {
        console.error('[flow-runs] Looking for replies sent while the bot was down failed:', error);
    } finally {
        messageWaitsHeld = false;
    }
}

/**
 * Hand back resume claims left behind by a process that died holding them.
 *
 * Startup only. See {@link FlowRunsRepo.reclaimAbandonedClaims} for why that
 * timing is what makes reclaiming *every* outstanding claim safe, and what would
 * have to change first before this could run on a timer.
 */
export async function reclaimStrandedFlowRuns(
    dependencies: Pick<FlowRunSchedulerDependencies, 'flowRunsRepo'> = defaultDependencies
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
 *
 * A due run carrying a quiet window may not be due after all: see
 * {@link deferIfMessaged}, which runs first and can push its deadline back instead.
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
        const now = new Date();
        // While activity is still backfilling messages missed during an outage, "when did
        // they last speak" is not answerable yet, so runs with a quiet window are held:
        // not even fetched, so not resumed, their `wakeAt` untouched, and the next tick
        // asks again. The startup sweep runs the moment the bot is ready, which is exactly
        // when that history is missing. Message waits are held for longer — until the
        // catch-up has looked for their replies too — because timing one out now would
        // end a wait whose member answered in time. Every other run is unaffected.
        const backfillPending = dependencies.isBackfillPending();
        const dueRuns = await dependencies.flowRunsRepo.findDue(now, {
            withoutQuietWindows: backfillPending,
            withoutMessageWaits: backfillPending || messageWaitsHeld,
        });
        if (dueRuns.length === 0) {
            return;
        }

        console.info(`[flow-runs] Found ${dueRuns.length} due run(s)`);

        for (const run of dueRuns) {
            try {
                // A failed lookup throws into the catch below and leaves the run
                // parked for the next tick. Timing out on a guess would end a run
                // whose member may well still be talking.
                if (await deferIfMessaged(client, run, now, dependencies)) {
                    continue;
                }

                const outcome = await resumeFlowRun(client, run, RESUME_TIMEOUT);
                if (outcome.status === 'failed') {
                    console.warn(`[flow-runs] Run ${run.runId} failed on resume: ${outcome.error}`);
                }
            } catch (error) {
                console.error(`[flow-runs] Unexpected error handling due run ${run.runId}:`, error);
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
 * Push a quiet-window park's deadline back while qualifying messages keep landing.
 * Returns true when the run must not be resumed on this tick.
 *
 * The deadline is `max(wakeAt, lastMessageAt + durationMs)`: the first `wakeAt` is
 * the park plus the same span, so only a message *after* the park can move it. If
 * that later deadline is still ahead, `wakeAt` moves there and the run sleeps on.
 * Otherwise it is genuinely quiet, and the caller resumes it with `timeout` as for
 * any other due run.
 *
 * The scheduler does this, not the block, for three reasons: a block that woke to
 * check would re-post whatever its parking leg posts (a question's buttons), every
 * wake would spend a visit (a member posting just inside each window would drain
 * the budget and fail the run), and the block would have to know about messages at
 * all. This way a block sees `timeout` only when it is true.
 *
 * Losing the race to a claim or a re-park also returns true: `deferWake` matched
 * nothing because something else moved the run, and that something now owns it. A
 * resume here would time out a park nobody asked to end.
 *
 * Never reached while activity is backfilling: the tick does not fetch quiet-window
 * runs then (see {@link runFlowRunTick}).
 *
 * A window counting the member's messages on a run about nobody is ended here, failed by
 * name, and also returns true. Save-time validation makes it unreachable — that option
 * requires a member — but throwing instead would leave the run parked, retried every tick
 * forever while holding a slot in the due batch.
 */
async function deferIfMessaged(
    client: Client,
    run: FlowRunEntity,
    now: Date,
    dependencies: FlowRunSchedulerDependencies
): Promise<boolean> {
    const quiet = run.quietWindow;
    if (!quiet || !run.wakeAt) {
        return false;
    }

    let lastMessageAt: Date | null;
    if (quiet.who === 'member') {
        const { userId } = run.contextSnapshot;
        if (!userId) {
            const reason =
                `Run ${run.runId} counts its time limit from the member's last message, but it is about ` +
                'nobody, so there is no member whose messages to count.';
            // Claimed on the park this tick read, so a run that has since woken and parked
            // again is not the one ended.
            const outcome = await failParkedRun(client, run, reason, {
                wakeAt: run.wakeAt,
                ...(run.resumeNodeId ? { resumeNodeId: run.resumeNodeId } : {}),
            });
            if (outcome.status === 'skipped') {
                console.info(`[flow-runs] Did not end run ${run.runId}: it moved on before it could be claimed.`);
            } else {
                console.warn(`[flow-runs] Ended run ${run.runId}: ${reason}`);
            }
            return true;
        }
        lastMessageAt = await dependencies.activityEventsRepo.findLastMessageAt({
            guildId: run.guildId,
            userId,
            ...(quiet.channelId ? { channelId: quiet.channelId } : {}),
        });
    } else {
        lastMessageAt = await dependencies.activityEventsRepo.findLastMessageAt({
            guildId: run.guildId,
            channelId: quiet.channelId,
        });
    }
    if (!lastMessageAt) {
        return false;
    }

    const nextWakeAt = new Date(lastMessageAt.getTime() + quiet.durationMs);
    if (nextWakeAt <= now) {
        return false;
    }

    await dependencies.flowRunsRepo.deferWake(run.runId, run.wakeAt, nextWakeAt);
    return true;
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
    messageWaitsHeld = false;
}
