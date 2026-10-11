import type { Client } from 'discord.js';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { database } from '../../../../features-system/data-persistence/database';
import { resetMissingTableReportsForTests } from '../../../../features-system/data-persistence/missingTable';
import { migrateTestDatabase } from '../../../../features-system/data-persistence/__tests__/support/migrateTestDatabase';
import { guildSettingsRepo } from '../../../../features-system/guild-settings';
import { TestDiscord, type ServerChannel, type ServerGuild } from '../../../../shared/__tests__/support/testDiscord';
import { ACTION_DELAY } from '../../blocks/actionDelay';
import { ACTION_SEND_MESSAGE } from '../../blocks/actionSendMessage';
import { ensureBlocksDiscovered } from '../../blocks/registry';
import { TRIGGER_SCHEDULE, type ScheduleConfig } from '../../blocks/triggerSchedule';
import { FLOW_ROOT_CHAIN_DEPTH } from '../../constants';
import { FLOW_GRAPH_VERSION, type FlowEdge, type FlowGraph, type FlowNode } from '../../data/flowGraph';
import { flowRunsRepo } from '../../data/flowRunsRepo';
import { flowSchedulesRepo } from '../../data/flowSchedulesRepo';
import type { FlowScheduleEntity } from '../../data/flowSchedulesSchema';
import { flowsRepo } from '../../data/flowsRepo';
import { resetFlowRunSchedulerForTests, runFlowRunTick } from '../../engine/flowRunScheduler';
import type { TriggeredRun } from '../../engine/triggeredRun';

/**
 * Firing due schedules against the real migrated schema, real discord.js against
 * TestDiscord, and the real executor — so a fire shows up as a message the run posted,
 * and a park as a real `flow_runs` row.
 *
 * `startTriggeredRun` is wrapped, not replaced, so each case can also read the seed a fire
 * handed over. The clock is handed in; each guild is new, so no case sees another's rows.
 */

const startTriggeredRun = vi.fn();
vi.mock('../../engine/triggeredRun', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../engine/triggeredRun')>();
    startTriggeredRun.mockImplementation((run: TriggeredRun) => actual.startTriggeredRun(run));
    return { ...actual, startTriggeredRun: (run: TriggeredRun) => startTriggeredRun(run) };
});

const { fireDueSchedules } = await import('../fireDueSchedules');
const { reconcileGuildSchedules } = await import('../reconcileGuildSchedules');

/** 2026-07-01, noon UTC: 05:00 in Los Angeles. Every guild here runs on the Pacific default. */
const NOON = new Date('2026-07-01T12:00:00.000Z');
const DAILY_NINE: ScheduleConfig = { repeat: 'daily', time: '09:00' };

const discord = new TestDiscord();
let client: Client<true>;

const at = (instant: Date) => () => instant;

interface Place {
    readonly guild: ServerGuild;
    readonly channel: ServerChannel;
}

/** A guild the bot is in, with a channel the scheduled runs post into. Built before `start`. */
const places: Place[] = [];
function place(index: number): Place {
    return places[index];
}

function node(id: string, type: string, data: Record<string, unknown>): FlowNode {
    return { id, type, position: { x: 0, y: 0 }, data };
}

/** Schedule → Send Message, optionally with a Delay between them so the run parks. */
function postingGraph(channelId: string, config: ScheduleConfig, parks = false, tag = 'fired'): FlowGraph {
    const nodes = [node('schedule', TRIGGER_SCHEDULE, config), node('post', ACTION_SEND_MESSAGE, { channelId, message: tag })];
    const edges: FlowEdge[] = [];
    if (parks) {
        nodes.push(node('wait', ACTION_DELAY, { durationMs: 60 * 60_000 }));
        edges.push({ id: 'e1', source: 'schedule', target: 'wait' }, { id: 'e2', source: 'wait', target: 'post' });
    } else {
        edges.push({ id: 'e1', source: 'schedule', target: 'post' });
    }
    return { version: FLOW_GRAPH_VERSION, nodes, edges };
}

/** A switched-on scheduled flow in `guildId`, reconciled, with its one row made due at `dueAt`. */
async function dueFlow(
    guildId: string,
    graph: FlowGraph,
    dueAt: Date = new Date('2026-07-01T11:00:00.000Z')
): Promise<{ flowId: string; row: FlowScheduleEntity }> {
    const flow = await flowsRepo.create({ guildId, name: 'On the clock', graph, enabled: true });
    await reconcileGuildSchedules(guildId, at(NOON));
    await database
        .updateTable('flow_schedules')
        .set({ nextRunAt: dueAt.toISOString() })
        .where('flowId', '=', flow.flowId)
        .execute();
    return { flowId: flow.flowId, row: await rowOf(flow.flowId) };
}

async function rowOf(flowId: string): Promise<FlowScheduleEntity> {
    const row = await database.selectFrom('flow_schedules').selectAll().where('flowId', '=', flowId).executeTakeFirst();
    if (!row) throw new Error(`No schedule row for flow ${flowId}`);
    return row;
}

function botSaid({ guild, channel }: Place): string[] {
    return channel.messages.filter((message) => message.authorId === guild.bot.id).map((message) => message.content);
}

beforeAll(async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await ensureBlocksDiscovered();
    await migrateTestDatabase();
    for (let index = 0; index < 16; index += 1) {
        const guild = discord.createGuild();
        places.push({ guild, channel: guild.createTextChannel({ name: `dungeon-${index}` }) });
    }
    client = await discord.start();
}, 30_000);

afterAll(async () => {
    resetFlowRunSchedulerForTests();
    vi.restoreAllMocks();
    await discord.destroy();
});

beforeEach(async () => {
    startTriggeredRun.mockClear();
    resetMissingTableReportsForTests();
    // A row one case left due would fire in the next; each case starts with none.
    await database.deleteFrom('flow_schedules').execute();
});

afterEach(() => {
    resetFlowRunSchedulerForTests();
    // Only the console spies a case set up — the wrapped `startTriggeredRun` must survive.
    for (const method of ['info', 'warn', 'error'] as const) {
        if (vi.isMockFunction(console[method])) {
            vi.mocked(console[method]).mockRestore();
        }
    }
});

/**
 * Scheduler dependencies with no parked run due and the backfill over — so anything a tick
 * does comes from `onTick`.
 */
function tickDeps(findDue: () => Promise<never[]>) {
    return {
        flowRunsRepo: { findDue: vi.fn(findDue), reclaimAbandonedClaims: vi.fn(), deferWake: vi.fn(), findWaiting: vi.fn() },
        activityEventsRepo: { findLastMessageAt: vi.fn(), findLastMessageBetween: vi.fn() },
        isBackfillPending: () => false,
        afterBackfill: (callback: () => void) => callback(),
        onTick: (tickClient: Client) => fireDueSchedules(tickClient, at(NOON)),
    };
}

describe('fireDueSchedules', () => {
    it('fires a due schedule on a tick with no parked runs due, and on one where flow_runs is missing', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const first = place(0);
        const second = place(1);
        await dueFlow(first.guild.id, postingGraph(first.channel.id, DAILY_NINE));

        await runFlowRunTick(client, tickDeps(() => Promise.resolve([])));
        expect(botSaid(first)).toEqual(['fired']);

        await dueFlow(second.guild.id, postingGraph(second.channel.id, DAILY_NINE));
        await runFlowRunTick(client, tickDeps(() => Promise.reject(new Error('SqliteError: no such table: flow_runs'))));
        expect(botSaid(second)).toEqual(['fired']);
    });

    it('fires an overdue schedule missed several times once, and moves it past now', async () => {
        const target = place(2);
        // Due three days ago: missed on the 28th, 29th and 30th while the bot was down.
        const { flowId } = await dueFlow(target.guild.id, postingGraph(target.channel.id, DAILY_NINE), new Date('2026-06-28T16:00:00.000Z'));

        await fireDueSchedules(client, at(NOON));
        await fireDueSchedules(client, at(NOON));

        expect(botSaid(target)).toEqual(['fired']);
        expect((await rowOf(flowId)).nextRunAt).toEqual(new Date('2026-07-01T16:00:00.000Z'));
    });

    it("works out each row's next time from a fresh now, not one taken when the tick began", async () => {
        const target = place(3);
        const every15: ScheduleConfig = { repeat: 'interval', every: '15m' };
        const first = await dueFlow(target.guild.id, postingGraph(target.channel.id, every15), new Date('2026-07-01T11:00:00.000Z'));
        const second = await dueFlow(target.guild.id, postingGraph(target.channel.id, every15), new Date('2026-07-01T11:01:00.000Z'));

        // The read, then one reading per row — as though the first row's run took 20 minutes.
        const readings = [NOON, NOON, new Date('2026-07-01T12:20:00.000Z')];
        await fireDueSchedules(client, () => readings.shift() ?? NOON);

        expect((await rowOf(first.flowId)).nextRunAt).toEqual(new Date('2026-07-01T12:15:00.000Z'));
        expect((await rowOf(second.flowId)).nextRunAt).toEqual(new Date('2026-07-01T12:30:00.000Z'));
    });

    it('does not fire when another advance won the row first', async () => {
        const target = place(4);
        await dueFlow(target.guild.id, postingGraph(target.channel.id, DAILY_NINE));
        const advance = vi.spyOn(flowSchedulesRepo, 'advance').mockResolvedValueOnce(false);

        await fireDueSchedules(client, at(NOON));
        advance.mockRestore();

        expect(botSaid(target)).toEqual([]);
        expect(startTriggeredRun).not.toHaveBeenCalled();
    });

    it('skips, and logs, while the last run is parked — and fires once it has completed', async () => {
        const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
        const target = place(5);
        const { flowId, row } = await dueFlow(target.guild.id, postingGraph(target.channel.id, DAILY_NINE));
        const parked = await flowRunsRepo.create({
            flowId,
            guildId: target.guild.id,
            contextSnapshot: { guildId: target.guild.id },
            resumeNodeId: 'post',
            wakeAt: new Date('2026-07-02T00:00:00.000Z'),
            visitsUsed: 1,
            log: [],
        });
        await flowSchedulesRepo.setLastRunId(row.id, parked.runId);

        await fireDueSchedules(client, at(NOON));
        expect(botSaid(target)).toEqual([]);
        expect(info).toHaveBeenCalledWith(expect.stringMatching(new RegExp(`Skipped schedule schedule in flow ${flowId}: its last run`)));

        await flowRunsRepo.claimForResume(parked.runId);
        await flowRunsRepo.complete(parked.runId);
        await database.updateTable('flow_schedules').set({ nextRunAt: '2026-07-01T11:30:00.000Z' }).where('id', '=', row.id).execute();
        await fireDueSchedules(client, at(NOON));
        expect(botSaid(target)).toEqual(['fired']);
    });

    it('records the run that parked, and skips the next time after the flow is switched off and on', async () => {
        vi.spyOn(console, 'info').mockImplementation(() => undefined);
        const target = place(6);
        const { flowId } = await dueFlow(target.guild.id, postingGraph(target.channel.id, DAILY_NINE, true));

        await fireDueSchedules(client, at(NOON));
        const recorded = (await rowOf(flowId)).lastRunId;
        expect(recorded).not.toBeNull();
        expect((await flowRunsRepo.getByRunId(recorded ?? ''))?.status).toBe('suspended');

        await flowsRepo.update(flowId, { enabled: false });
        await reconcileGuildSchedules(target.guild.id, at(NOON));
        await flowsRepo.update(flowId, { enabled: true });
        await reconcileGuildSchedules(target.guild.id, at(NOON));
        expect((await rowOf(flowId)).lastRunId).toBe(recorded);

        await database.updateTable('flow_schedules').set({ nextRunAt: '2026-07-01T11:30:00.000Z' }).where('flowId', '=', flowId).execute();
        await fireDueSchedules(client, at(NOON));

        expect(startTriggeredRun).toHaveBeenCalledTimes(1);
    });

    it('gives a row whose next time cannot be worked out no next time, logs it, and does not retry it', async () => {
        const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const target = place(7);
        const { flowId, row } = await dueFlow(target.guild.id, postingGraph(target.channel.id, DAILY_NINE));
        // A zone the runtime no longer knows, with the row keyed on it — as though reconcile
        // ran while the zone data still had it.
        await guildSettingsRepo.setTimeZone(target.guild.id, 'UTC');
        await database.updateTable('guild_settings').set({ timeZone: 'Mars/Olympus_Mons' }).where('guildId', '=', target.guild.id).execute();
        await database
            .updateTable('flow_schedules')
            .set({ configKey: row.configKey.replace('America/Los_Angeles', 'Mars/Olympus_Mons') })
            .where('id', '=', row.id)
            .execute();

        await fireDueSchedules(client, at(NOON));
        await fireDueSchedules(client, at(NOON));

        expect((await rowOf(flowId)).nextRunAt).toBeNull();
        expect(botSaid(target)).toEqual([]);
        expect(error.mock.calls.filter(([line]) => String(line).includes('"Mars/Olympus_Mons" is not one this runtime knows'))).toHaveLength(1);
    });

    it("reconciles instead of firing when the row's key no longer matches its node", async () => {
        vi.spyOn(console, 'info').mockImplementation(() => undefined);
        const target = place(8);
        const { flowId, row } = await dueFlow(target.guild.id, postingGraph(target.channel.id, DAILY_NINE));
        // Saved without its reconcile — nothing is registered after writes in this file.
        await flowsRepo.update(flowId, { graph: postingGraph(target.channel.id, { repeat: 'daily', time: '10:00' }) });

        await fireDueSchedules(client, at(NOON));

        expect(botSaid(target)).toEqual([]);
        const after = await rowOf(flowId);
        expect(after.configKey).not.toBe(row.configKey);
        expect(after.nextRunAt).toEqual(new Date('2026-07-01T17:00:00.000Z'));
    });

    it('takes a mismatched row off the due list even when its reconcile fails, so it is not retried every tick', async () => {
        vi.spyOn(console, 'info').mockImplementation(() => undefined);
        const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const target = place(12);
        const { flowId } = await dueFlow(target.guild.id, postingGraph(target.channel.id, DAILY_NINE));
        await flowsRepo.update(flowId, { graph: postingGraph(target.channel.id, { repeat: 'daily', time: '10:00' }) });
        const read = vi.spyOn(flowsRepo, 'getByGuildId').mockRejectedValue(new Error('one unreadable graph'));

        await fireDueSchedules(client, at(NOON));
        await fireDueSchedules(client, at(NOON));
        read.mockRestore();

        expect((await rowOf(flowId)).nextRunAt).toBeNull();
        expect(error.mock.calls.filter(([line]) => String(line).includes('Could not bring the schedules'))).toHaveLength(1);
        expect(botSaid(target)).toEqual([]);
    });

    it('advances, and logs, a schedule in a guild the bot is not in, without starting a run', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const { flowId } = await dueFlow('guild-the-bot-left', postingGraph('nowhere', DAILY_NINE));

        await fireDueSchedules(client, at(NOON));

        expect(startTriggeredRun).not.toHaveBeenCalled();
        expect((await rowOf(flowId)).nextRunAt).toEqual(new Date('2026-07-01T16:00:00.000Z'));
        expect(warn).toHaveBeenCalledWith(expect.stringMatching(/guild guild-the-bot-left is not available to this bot/));
    });

    it('keeps one throwing row from stopping the next', async () => {
        const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const broken = place(9);
        const working = place(10);
        await dueFlow(broken.guild.id, postingGraph(broken.channel.id, DAILY_NINE), new Date('2026-07-01T10:00:00.000Z'));
        await dueFlow(working.guild.id, postingGraph(working.channel.id, DAILY_NINE), new Date('2026-07-01T10:30:00.000Z'));
        const read = vi.spyOn(flowsRepo, 'getByFlowId').mockRejectedValueOnce(new Error('row on fire'));

        await fireDueSchedules(client, at(NOON));
        read.mockRestore();

        expect(botSaid(working)).toEqual(['fired']);
        expect(error).toHaveBeenCalledWith(expect.stringMatching(/could not be fired/), expect.any(Error));
    });

    it('takes a row whose flow will not read off the due list, naming the flow and guild, and does not retry it', async () => {
        const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const target = place(13);
        const { flowId } = await dueFlow(target.guild.id, postingGraph(target.channel.id, DAILY_NINE));
        // A stored graph that no longer passes the structural check, as `assertValidGraph` throws.
        const read = vi
            .spyOn(flowsRepo, 'getByFlowId')
            .mockRejectedValue(new Error(`Flow ${flowId} has an invalid stored graph: edge e1 points at nothing`));

        await fireDueSchedules(client, at(NOON));
        await fireDueSchedules(client, at(NOON));
        const reads = read.mock.calls.length;
        read.mockRestore();

        expect((await rowOf(flowId)).nextRunAt).toBeNull();
        // Read once: the second tick found nothing due.
        expect(reads).toBe(1);
        const lines = error.mock.calls.filter(([line]) => String(line).includes('could not be fired'));
        expect(lines).toHaveLength(1);
        expect(String(lines[0]?.[0])).toContain(`in flow ${flowId} (guild ${target.guild.id})`);
        expect(String(lines[0]?.[0])).toContain('will not be tried again until the flow is saved or the bot restarts');
        expect(botSaid(target)).toEqual([]);
    });

    it('leaves a row that moved on alone when its fire throws after advancing', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const target = place(14);
        const { flowId } = await dueFlow(target.guild.id, postingGraph(target.channel.id, DAILY_NINE, true));
        const record = vi.spyOn(flowSchedulesRepo, 'setLastRunId').mockRejectedValueOnce(new Error('disk full'));

        await fireDueSchedules(client, at(NOON));
        record.mockRestore();

        // It fired and advanced before the throw, so it keeps its next time.
        expect((await rowOf(flowId)).nextRunAt).toEqual(new Date('2026-07-01T16:00:00.000Z'));
    });

    it('starts a run about nobody — no member, actor or channel — at the root of any chain', async () => {
        const target = place(11);
        await dueFlow(target.guild.id, postingGraph(target.channel.id, DAILY_NINE));

        await fireDueSchedules(client, at(NOON));

        expect(startTriggeredRun).toHaveBeenCalledTimes(1);
        const [run] = startTriggeredRun.mock.calls[0] as [TriggeredRun];
        expect(run.source).toBe('scheduleDue');
        expect(run.limit).toBeUndefined();
        expect(run.seed.subject).toBeUndefined();
        expect(run.seed.actor).toBeUndefined();
        expect(run.seed.channel).toBeUndefined();
        expect(run.seed.guild.id).toBe(target.guild.id);
        expect(run.seed.chainDepth).toBe(FLOW_ROOT_CHAIN_DEPTH);
        expect(run.seed.variables).toEqual({});
    });

    it('says once that its table is missing, rather than every tick', async () => {
        const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const find = vi.spyOn(flowSchedulesRepo, 'findDue').mockRejectedValue(new Error('SqliteError: no such table: flow_schedules'));

        await fireDueSchedules(client, at(NOON));
        await fireDueSchedules(client, at(NOON));
        find.mockRestore();

        expect(error).toHaveBeenCalledTimes(1);
        expect(error).toHaveBeenCalledWith(expect.stringMatching(/flow_schedules table does not exist/));
    });
});
