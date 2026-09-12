import type { Client } from 'discord.js';
import { FlowRunsRepo, flowRunsRepo } from '../data/flowRunsRepo';
import type { FlowWaitKind } from '../data/flowRunsSchema';
import { resumeFlowRun } from './flowRunResume';

export type WaitingRunDependencies = {
    flowRunsRepo: Pick<FlowRunsRepo, 'findWaiting'>;
    resume?: typeof resumeFlowRun;
};

const defaultDependencies: WaitingRunDependencies = {
    flowRunsRepo,
};

/**
 * Wake every run parked on `action.waitForEvent` that this event satisfies.
 *
 * Matching is deliberately conservative — a run wakes only when ALL of:
 *  - it is still `pending` and has a `waitKind` (enforced by `findWaiting`)
 *  - the event's guild matches the run's `guildId`
 *  - the event's `eventKind` matches the run's `waitKind`
 *  - the event's user is the run's OWN user (`contextSnapshot.userId`)
 *
 * That last rule is the important one: a run waiting on `memberJoin` resumes
 * when *its* user rejoins, not when any member joins. Anything finer-grained
 * (a specific message or emoji) is intentionally out of scope for now — the wait
 * node's config carries only `eventKind`.
 *
 * Called by the dispatchers *in addition to* starting new flow runs, so an event
 * both fires matching triggers and wakes matching waits.
 */
export async function resumeWaitingRunsForEvent(
    client: Client,
    event: { guildId: string; userId: string; eventKind: FlowWaitKind },
    dependencies: WaitingRunDependencies = defaultDependencies
): Promise<number> {
    let resumedCount = 0;

    let waiting;
    try {
        waiting = await dependencies.flowRunsRepo.findWaiting({
            guildId: event.guildId,
            waitKind: event.eventKind,
        });
    } catch (error) {
        console.error('[flow-runs] Could not look up waiting runs:', error);
        return 0;
    }

    for (const run of waiting) {
        if (run.contextSnapshot.userId !== event.userId) {
            continue;
        }

        try {
            const outcome = await (dependencies.resume ?? resumeFlowRun)(client, run, 'event');
            if (outcome.status === 'failed') {
                console.warn(`[flow-runs] Waiting run ${run.runId} failed on resume: ${outcome.error}`);
            }
            if (outcome.status !== 'skipped') {
                resumedCount += 1;
            }
        } catch (error) {
            console.error(`[flow-runs] Unexpected error resuming waiting run ${run.runId}:`, error);
        }
    }

    return resumedCount;
}
