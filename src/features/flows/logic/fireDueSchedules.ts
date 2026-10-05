import type { Client } from 'discord.js';
import { isMissingTableError, reportMissingTableOnce } from '../../../features-system/data-persistence/missingTable';
import { guildSettingsRepo } from '../../../features-system/guild-settings';
import { FLOW_ROOT_CHAIN_DEPTH } from '../constants';
import { isLiveRunStatus } from '../data/flowRunLifecycle';
import { flowRunsRepo } from '../data/flowRunsRepo';
import { flowSchedulesRepo } from '../data/flowSchedulesRepo';
import type { FlowScheduleEntity } from '../data/flowSchedulesSchema';
import { flowsRepo } from '../data/flowsRepo';
import { startTriggeredRun } from '../engine/triggeredRun';
import { readScheduleNode, reconcileGuildSchedules, scheduleKey } from './reconcileGuildSchedules';
import { nextScheduleTime } from './scheduleTimes';

/*
 * Starting the Schedule triggers that have come due.
 *
 * Handed to the run scheduler as its `onTick` by `initFlows`, so it runs once per tick
 * after the due parked runs, inside the tick's one-at-a-time guard. In `logic/` rather
 * than `engine/` for the reason reconcile is: the engine never names schedules.
 *
 * Runs execute inline, as resumes do: a long run delays the next fires and resumes. That
 * is accepted at this scale — the 15-minute floor bounds how often any one schedule fires,
 * and skip-while-running stops one piling up.
 *
 * **Not held by the activity backfill.** A run about nobody cannot park on a message —
 * Wait For Event needs a member — so nothing a scheduled run does depends on the history
 * the backfill restores.
 */

/**
 * Fire every due schedule, up to one batch, each isolated: one that throws is logged, taken
 * off the due list, and the next still fires.
 *
 * `clock` is read afresh **for every row**: runs execute inline, so a time taken once at
 * the start of the tick goes stale, and a next time worked out from it could already be
 * past — firing the same schedule again on the next tick.
 */
export async function fireDueSchedules(client: Client, clock: () => Date = () => new Date()): Promise<void> {
    let due: FlowScheduleEntity[];
    try {
        due = await flowSchedulesRepo.findDue(clock());
    } catch (error) {
        if (isMissingTableError(error, 'flow_schedules')) {
            reportMissingTableOnce('flow_schedules', 'no Schedule trigger fires');
            return;
        }
        throw error;
    }

    for (const row of due) {
        try {
            await fireSchedule(client, row, clock());
        } catch (error) {
            await giveUpOnSchedule(row, error);
        }
    }
}

/**
 * Take a row whose fire threw off the due list, and say so — naming the flow and the guild
 * so an operator can find it — rather than leaving it due to throw again every tick at the
 * head of the batch (a stored graph that no longer reads, say).
 *
 * Only if the row still holds the time this tick read: a fire that threw after advancing,
 * or a write that moved the row meanwhile, has already put it where it belongs. With no
 * next time it stays put until the flow is saved again or the bot restarts, both of which
 * reconcile it — the same place a failed reconcile leaves things.
 */
async function giveUpOnSchedule(row: FlowScheduleEntity, error: unknown): Promise<void> {
    let parked = false;
    try {
        parked = row.nextRunAt !== null && (await flowSchedulesRepo.advance(row.id, row.nextRunAt, null));
    } catch (advanceError) {
        console.error(`[flows] Could not take schedule ${row.nodeId} in flow ${row.flowId} off the due list:`, advanceError);
    }

    console.error(
        `[flows] Schedule ${row.nodeId} in flow ${row.flowId} (guild ${row.guildId}) could not be fired` +
            (parked ? ', and will not be tried again until the flow is saved or the bot restarts' : '') +
            '. Open the flow to fix it:',
        error
    );
}

/**
 * Fire one due schedule, in this order:
 *
 * 1. **Check it still matches its node.** A flow or node that is gone, a flow switched
 *    off, a node whose settings no longer parse, or a key that differs from the row's — a
 *    reconcile that failed, or has not run yet — skips the fire, takes the row off the due
 *    list, and reconciles the guild, which gives it the time it should have.
 * 2. **Advance first.** The row's next time moves on before any run starts, conditional on
 *    the time this tick read: losing that race skips. A crash mid-run therefore never runs
 *    the same time twice — at most once, not at least once. A next time that cannot be
 *    worked out (a zone `Intl` rejects) is written as none, and the fire is skipped.
 * 3. **Check the guild** is one the bot is in, and that Discord has it available. If not,
 *    the row has still advanced, and is kept so the schedule picks up again if the bot is
 *    re-added or the outage ends.
 * 4. **Skip while running.** If the last run this schedule started is still parked or
 *    running, this time is skipped and logged.
 * 5. **Start the run**, about nobody: no member, no actor, no channel, no flood limit, at
 *    the root of any chain.
 * 6. **Remember a run that parked**, so the next fire can tell whether it is still going.
 */
async function fireSchedule(client: Client, row: FlowScheduleEntity, now: Date): Promise<void> {
    const readNextRunAt = row.nextRunAt;
    if (!readNextRunAt) {
        return;
    }

    const flow = await flowsRepo.getByFlowId(row.flowId);
    const node = flow?.graph.nodes.find((candidate) => candidate.id === row.nodeId);
    const schedule = node ? readScheduleNode(node) : undefined;
    const { effective: timeZone } = await guildSettingsRepo.getTimeZone(row.guildId);
    if (!flow || !node || !schedule || !flow.enabled || scheduleKey(schedule, timeZone) !== row.configKey) {
        console.info(
            `[flows] Schedule ${row.nodeId} in flow ${row.flowId} no longer matches its flow, so it was not fired; ` +
                `bringing guild ${row.guildId}'s schedules up to date instead.`
        );
        // Taken off the due list first, so a reconcile that keeps failing cannot have this
        // row retried — and logged — every tick, holding a slot at the front of the batch;
        // a failed reconcile logs itself and leaves the row there, with no time. One that
        // succeeds gives it whatever time it should have: every case that reaches here (a
        // changed key, a flow switched off, a node or flow gone, settings that no longer
        // parse) is one it rewrites or deletes a row with no time for.
        if (!(await flowSchedulesRepo.advance(row.id, readNextRunAt, null))) {
            return;
        }
        await reconcileGuildSchedules(row.guildId, () => now);
        return;
    }

    let nextRunAt: Date | null;
    try {
        nextRunAt = nextScheduleTime(schedule, timeZone, now);
    } catch (error) {
        if (!(error instanceof RangeError)) {
            throw error;
        }
        nextRunAt = null;
    }

    if (!(await flowSchedulesRepo.advance(row.id, readNextRunAt, nextRunAt))) {
        return;
    }

    if (!nextRunAt) {
        console.error(
            `[flows] Schedule ${row.nodeId} in flow ${row.flowId} was not fired: guild ${row.guildId}'s time zone ` +
                `"${timeZone}" is not one this runtime knows, so its next time cannot be worked out. It will not fire ` +
                'until the zone is changed in Server Settings.'
        );
        return;
    }

    // An unavailable guild is cached during a Discord outage; a run there could only fail.
    const guild = client.guilds.cache.get(row.guildId);
    if (!guild?.available) {
        console.warn(
            `[flows] Schedule ${row.nodeId} in flow ${row.flowId} came due, but guild ${row.guildId} is not available ` +
                `to this bot; skipped, next at ${nextRunAt.toISOString()}.`
        );
        return;
    }

    if (row.lastRunId) {
        const last = await flowRunsRepo.getByRunId(row.lastRunId);
        if (last && isLiveRunStatus(last.status)) {
            console.info(
                `[flows] Skipped schedule ${row.nodeId} in flow ${row.flowId}: its last run ${row.lastRunId} is still ` +
                    `${last.status === 'suspended' ? 'waiting' : 'running'}. Next at ${nextRunAt.toISOString()}.`
            );
            return;
        }
    }

    const result = await startTriggeredRun({
        flowId: flow.flowId,
        graph: flow.graph,
        triggerNodeId: node.id,
        source: 'scheduleDue',
        seed: { client, guild, variables: {}, chainDepth: FLOW_ROOT_CHAIN_DEPTH },
    });

    if (result?.parked) {
        await flowSchedulesRepo.setLastRunId(row.id, result.runId);
    }
}
