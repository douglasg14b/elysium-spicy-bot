import { isMissingTableError, reportMissingTableOnce } from '../../../features-system/data-persistence/missingTable';
import { guildSettingsRepo } from '../../../features-system/guild-settings';
import { visibleNodeData } from '../blocks/manifest';
import { getBlockDefinition } from '../blocks/registry';
import { resolveSchedule, scheduleConfigSchema, TRIGGER_SCHEDULE, type ResolvedSchedule } from '../blocks/triggerSchedule';
import type { FlowNode } from '../data/flowGraph';
import { flowSchedulesRepo, type FlowScheduleTarget } from '../data/flowSchedulesRepo';
import type { FlowScheduleEntity } from '../data/flowSchedulesSchema';
import { flowsRepo, type FlowsRepo } from '../data/flowsRepo';
import { assertTimeZone, nextScheduleTime } from './scheduleTimes';

/*
 * Keeping `flow_schedules` in step with a guild's saved flows.
 *
 * **Why here, and not in `engine/`.** The engine never names schedules: what a schedule
 * repeats on, and which time zone it is read in, are words its vocabulary gate keeps out.
 * So this lives in `logic/`, beside `ticketEventDispatch`, as a declared dependent of the
 * Schedule block.
 *
 * **Schedule nodes are picked by the block's own type**, not through the registry's
 * `scheduleDue` source: every node read here is parsed with this one block's schema, so
 * selecting by source would hand it any other block that ever declared the same source.
 *
 * Called from three places: after every committed flow write ({@link registerScheduleReconcile},
 * from `initFlows`), after the server's time zone changes (the time-zone route), and for
 * every guild at startup, before the run tick starts. Drafts never come through here: a
 * draft write does not go through `FlowsRepo`, and only the saved flow schedules anything.
 */

/**
 * A Schedule node as every reader of it sees it: the visible fields only, parsed by the
 * block's schema — so `days` is unique and Monday first, and a time left over from "Every
 * day" is not there under "Every so often" — and resolved to what its `repeat` uses.
 * Undefined for a node whose config does not parse, or that is not a Schedule trigger.
 */
export function readScheduleNode(node: FlowNode): ResolvedSchedule | undefined {
    const definition = node.type === TRIGGER_SCHEDULE ? getBlockDefinition(node.type) : undefined;
    if (!definition) {
        return undefined;
    }

    const parsed = scheduleConfigSchema.safeParse(visibleNodeData(definition.configFields, node.data));
    return parsed.success ? resolveSchedule(parsed.data) : undefined;
}

/**
 * The identity of a schedule: what its `repeat` uses, plus the server's effective time
 * zone, as stable JSON.
 *
 * Built member by member in a fixed order — every member present, `null` where the repeat
 * has none — rather than from whatever object it was handed, so a deploy that adds a field
 * or a default elsewhere cannot change it. A changed key gets a fresh next time from now,
 * which would quietly drop the catch-up for a time missed while the bot was down, and
 * deploys are exactly when the bot is down.
 */
export function scheduleKey(schedule: ResolvedSchedule, timeZone: string): string {
    switch (schedule.repeat) {
        case 'daily':
            return JSON.stringify({ repeat: schedule.repeat, time: schedule.time, days: null, every: null, timeZone });
        case 'days':
            return JSON.stringify({ repeat: schedule.repeat, time: schedule.time, days: schedule.days, every: null, timeZone });
        case 'interval':
            return JSON.stringify({ repeat: schedule.repeat, time: null, days: null, every: schedule.every, timeZone });
        default: {
            const illegal: never = schedule;
            throw new Error(`Unknown schedule ${JSON.stringify(illegal)}.`);
        }
    }
}

/**
 * Reconcile the written guild after every committed flow write, finishing before the write
 * returns — so the builder's next-runs fetch after a save sees the new times. The one place
 * this wiring is written: `initFlows` calls it, and so do the tests and the dashboard e2e
 * boot that stand in for it.
 */
export function registerScheduleReconcile(repo: Pick<FlowsRepo, 'registerAfterWrite'> = flowsRepo): void {
    repo.registerAfterWrite(({ guildId }) => reconcileGuildSchedules(guildId));
}

/** In-flight reconciles, one chain per guild. */
const chains = new Map<string, Promise<void>>();

/**
 * Bring a guild's `flow_schedules` rows in line with its saved flows and its time zone.
 *
 * - **A new schedule** gets a row with its next time from now — or no time, when its flow
 *   is switched off.
 * - **An unchanged schedule on a switched-on flow is left alone.** That is what makes a
 *   time missed while the bot was down fire once when it is back.
 * - **A changed schedule, or a changed time zone**, gets a fresh next time from now and
 *   keeps `lastRunId`, so skip-while-running holds across the edit.
 * - **A switched-off flow** keeps its rows with no next time, and their `lastRunId`. Its
 *   parked runs carry on, and the row is the only link to them.
 * - **A flow switched back on** gets a fresh next time from now: times passed while it was
 *   off do not run.
 * - **A row whose node or flow is gone** is deleted. A node whose config no longer parses
 *   keeps its row, with no next time — and is logged when its flow is switched on, where it
 *   is a schedule that silently stopped; on a switched-off flow it is work in progress.
 * - **A zone `Intl` rejects** — possible only if the runtime's time zone data changed,
 *   since the setting is validated on write — gives every row in the guild no next time,
 *   with an error naming the guild and the zone. Nothing falls back to another zone.
 *
 * **Serialised per guild, and that is load-bearing.** Each reconcile deletes the rows it
 * read whose node is gone; one working from a stale read, overlapping a newer one, would
 * delete rows the newer one had just created. **Never throws:** a failure is logged and not
 * retried on a timer — the next flow write, zone change or restart reconciles again, and
 * firing checks each row against its node before it fires, which guards the gap. A missing
 * `flow_schedules` table is said once per process, not per guild and per save.
 */
export function reconcileGuildSchedules(guildId: string, now: () => Date = () => new Date()): Promise<void> {
    const previous = chains.get(guildId) ?? Promise.resolve();
    const current = previous.then(() => reconcileLogged(guildId, now));
    chains.set(guildId, current);
    const forget = (): void => {
        if (chains.get(guildId) === current) {
            chains.delete(guildId);
        }
    };
    void current.then(forget, forget);
    return current;
}

async function reconcileLogged(guildId: string, now: () => Date): Promise<void> {
    try {
        await reconcileNow(guildId, now());
    } catch (error) {
        if (isMissingTableError(error, 'flow_schedules')) {
            reportMissingTableOnce('flow_schedules', 'no Schedule trigger is kept or fires');
            return;
        }
        console.error(
            `[flows] Could not bring the schedules of guild ${guildId} up to date; the next flow save, ` +
                'time zone change or restart tries again:',
            error
        );
    }
}

async function reconcileNow(guildId: string, now: Date): Promise<void> {
    // One after another rather than together: on SQLite they share one connection anyway.
    const flows = await flowsRepo.getByGuildId(guildId);
    const { effective: timeZone } = await guildSettingsRepo.getTimeZone(guildId);
    const rows = await flowSchedulesRepo.listForGuild(guildId);

    const held = new Map(rows.map((row) => [rowKey(row), row]));
    const zoneUsable = isUsableZone(guildId, timeZone);
    const wanted: FlowScheduleTarget[] = [];

    for (const flow of flows) {
        for (const node of flow.graph.nodes) {
            if (node.type !== TRIGGER_SCHEDULE) {
                continue;
            }

            const target = { flowId: flow.flowId, nodeId: node.id };
            const row = held.get(rowKey(target));
            const schedule = readScheduleNode(node);

            if (!schedule) {
                // Kept rather than deleted — the node is still there, and its row may be
                // the only link to a run it started that is still parked — but never due.
                if (flow.enabled) {
                    console.warn(
                        `[flows] Schedule ${node.id} in flow ${flow.flowId} (guild ${guildId}) has settings that do not ` +
                            'parse, so it will not fire until it is fixed and saved.'
                    );
                }
                if (row) {
                    wanted.push(target);
                    if (row.nextRunAt !== null) {
                        await flowSchedulesRepo.upsert({ ...target, guildId, configKey: row.configKey, nextRunAt: null });
                    }
                }
                continue;
            }

            wanted.push(target);
            const configKey = scheduleKey(schedule, timeZone);

            if (!flow.enabled || !zoneUsable) {
                if (!row || row.nextRunAt !== null || row.configKey !== configKey) {
                    await flowSchedulesRepo.upsert({ ...target, guildId, configKey, nextRunAt: null });
                }
                continue;
            }

            // Unchanged and live: leave it, so a time missed while the bot was down stays due.
            if (row && row.configKey === configKey && row.nextRunAt !== null) {
                continue;
            }

            await flowSchedulesRepo.upsert({ ...target, guildId, configKey, nextRunAt: nextScheduleTime(schedule, timeZone, now) });
        }
    }

    // The rows read whose node or flow is gone. Picked from what was read rather than by a
    // "keep these" clause, so the delete is one `id IN (…)` however many schedules there are.
    const wantedKeys = new Set(wanted.map(rowKey));
    await flowSchedulesRepo.deleteByIds(rows.filter((row) => !wantedKeys.has(rowKey(row))).map((row) => row.id));
}

/** Whether `Intl` accepts the guild's zone, logging the error that says so when it does not. */
function isUsableZone(guildId: string, timeZone: string): boolean {
    try {
        assertTimeZone(timeZone);
        return true;
    } catch (error) {
        if (!(error instanceof RangeError)) {
            throw error;
        }
        console.error(
            `[flows] Guild ${guildId}'s time zone "${timeZone}" is not one this runtime knows, so none of its ` +
                'schedules will fire until the zone is changed in Server Settings.'
        );
        return false;
    }
}

function rowKey(target: Pick<FlowScheduleEntity, 'flowId' | 'nodeId'>): string {
    return `${target.flowId}\u0000${target.nodeId}`;
}
