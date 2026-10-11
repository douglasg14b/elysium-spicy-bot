import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { database } from '../../../../features-system/data-persistence/database';
import { resetMissingTableReportsForTests } from '../../../../features-system/data-persistence/missingTable';
import { migrateTestDatabase } from '../../../../features-system/data-persistence/__tests__/support/migrateTestDatabase';
import { guildSettingsRepo } from '../../../../features-system/guild-settings';
import { ACTION_SEND_MESSAGE } from '../../blocks/actionSendMessage';
import { ensureBlocksDiscovered } from '../../blocks/registry';
import { TRIGGER_SCHEDULE } from '../../blocks/triggerSchedule';
import { FLOW_GRAPH_VERSION, type FlowGraph, type FlowNode } from '../../data/flowGraph';
import { flowSchedulesRepo } from '../../data/flowSchedulesRepo';
import type { FlowScheduleEntity } from '../../data/flowSchedulesSchema';
import { flowsRepo } from '../../data/flowsRepo';
import { reconcileGuildSchedules } from '../reconcileGuildSchedules';

/**
 * Reconcile against the real migrated schema: real `flows`, `guild_settings` and
 * `flow_schedules` rows, with the clock handed in. No Discord — reconcile only reads the
 * saved flows and the guild's zone.
 *
 * Every guild here is new, so no case sees another's rows. Unset zones read as Pacific.
 */

/** 2026-07-01, noon UTC: 05:00 in Los Angeles (daylight time, UTC−7). */
const NOON = new Date('2026-07-01T12:00:00.000Z');
/** 09:00 Los Angeles on 2026-07-01. */
const NINE_AM_TODAY = new Date('2026-07-01T16:00:00.000Z');

let guildCount = 0;
function newGuild(): string {
    guildCount += 1;
    return `guild-${guildCount}`;
}

const at = (instant: Date) => () => instant;

function scheduleNode(data: Record<string, unknown>, id = 'schedule'): FlowNode {
    return { id, type: TRIGGER_SCHEDULE, position: { x: 0, y: 0 }, data };
}

function graphOf(...nodes: FlowNode[]): FlowGraph {
    return { version: FLOW_GRAPH_VERSION, nodes, edges: [] };
}

async function rowsOf(guildId: string): Promise<FlowScheduleEntity[]> {
    return flowSchedulesRepo.listForGuild(guildId);
}

async function onlyRow(guildId: string): Promise<FlowScheduleEntity> {
    const rows = await rowsOf(guildId);
    expect(rows).toHaveLength(1);
    return rows[0];
}

async function scheduledFlow(guildId: string, data: Record<string, unknown>, enabled = true): Promise<string> {
    const flow = await flowsRepo.create({ guildId, name: 'On the clock', graph: graphOf(scheduleNode(data)), enabled });
    return flow.flowId;
}

beforeAll(async () => {
    await ensureBlocksDiscovered();
    await migrateTestDatabase();
}, 30_000);

afterEach(() => {
    vi.restoreAllMocks();
    resetMissingTableReportsForTests();
});

describe('reconcileGuildSchedules', () => {
    it('gives a new schedule on a switched-on flow a row with its next time', async () => {
        const guildId = newGuild();
        const flowId = await scheduledFlow(guildId, { repeat: 'daily', time: '09:00' });

        await reconcileGuildSchedules(guildId, at(NOON));

        const row = await onlyRow(guildId);
        expect(row).toMatchObject({ guildId, flowId, nodeId: 'schedule', nextRunAt: NINE_AM_TODAY, lastRunId: null });
    });

    it('keeps the next time through an edit that does not touch the schedule', async () => {
        const guildId = newGuild();
        const flowId = await scheduledFlow(guildId, { repeat: 'daily', time: '09:00' });
        await reconcileGuildSchedules(guildId, at(NOON));

        const send: FlowNode = {
            id: 'send',
            type: ACTION_SEND_MESSAGE,
            position: { x: 200, y: 0 },
            data: { channelId: 'c', message: 'hi' },
        };
        await flowsRepo.update(flowId, { name: 'Renamed', graph: graphOf(scheduleNode({ repeat: 'daily', time: '09:00' }), send) });
        await reconcileGuildSchedules(guildId, at(new Date('2026-07-01T14:00:00.000Z')));

        expect((await onlyRow(guildId)).nextRunAt).toEqual(NINE_AM_TODAY);
    });

    it('keeps the next time when the same days are picked in another order', async () => {
        const guildId = newGuild();
        const flowId = await scheduledFlow(guildId, { repeat: 'days', time: '09:00', days: ['mon', 'wed', 'fri'] });
        await reconcileGuildSchedules(guildId, at(NOON));
        const before = await onlyRow(guildId);

        await flowsRepo.update(flowId, { graph: graphOf(scheduleNode({ repeat: 'days', time: '09:00', days: ['fri', 'mon', 'wed'] })) });
        await reconcileGuildSchedules(guildId, at(new Date('2026-07-01T14:00:00.000Z')));

        const after = await onlyRow(guildId);
        expect(after.configKey).toBe(before.configKey);
        expect(after.nextRunAt).toEqual(before.nextRunAt);
    });

    it('works out a fresh next time from now when the schedule changes, keeping its last run', async () => {
        const guildId = newGuild();
        const flowId = await scheduledFlow(guildId, { repeat: 'daily', time: '09:00' });
        await reconcileGuildSchedules(guildId, at(NOON));
        await flowSchedulesRepo.setLastRunId((await onlyRow(guildId)).id, 'run-parked');

        await flowsRepo.update(flowId, { graph: graphOf(scheduleNode({ repeat: 'daily', time: '10:00' })) });
        await reconcileGuildSchedules(guildId, at(NOON));

        const row = await onlyRow(guildId);
        expect(row.nextRunAt).toEqual(new Date('2026-07-01T17:00:00.000Z'));
        expect(row.lastRunId).toBe('run-parked');
    });

    it('nulls the next time of a switched-off flow, keeping the row and its last run', async () => {
        const guildId = newGuild();
        const flowId = await scheduledFlow(guildId, { repeat: 'daily', time: '09:00' });
        await reconcileGuildSchedules(guildId, at(NOON));
        await flowSchedulesRepo.setLastRunId((await onlyRow(guildId)).id, 'run-parked');

        await flowsRepo.update(flowId, { enabled: false });
        await reconcileGuildSchedules(guildId, at(NOON));

        expect(await onlyRow(guildId)).toMatchObject({ nextRunAt: null, lastRunId: 'run-parked' });
    });

    it('gives a new schedule on a switched-off flow a row with no next time', async () => {
        const guildId = newGuild();
        await scheduledFlow(guildId, { repeat: 'daily', time: '09:00' }, false);

        await reconcileGuildSchedules(guildId, at(NOON));

        expect((await onlyRow(guildId)).nextRunAt).toBeNull();
    });

    it('starts fresh from now when the flow is switched back on — times passed while off do not run', async () => {
        const guildId = newGuild();
        const flowId = await scheduledFlow(guildId, { repeat: 'daily', time: '09:00' });
        await reconcileGuildSchedules(guildId, at(NOON));
        await flowsRepo.update(flowId, { enabled: false });
        await reconcileGuildSchedules(guildId, at(NOON));

        // Switched back on the next evening: today's 09:00 has gone, so tomorrow's.
        await flowsRepo.update(flowId, { enabled: true });
        await reconcileGuildSchedules(guildId, at(new Date('2026-07-02T03:00:00.000Z')));

        expect((await onlyRow(guildId)).nextRunAt).toEqual(new Date('2026-07-02T16:00:00.000Z'));
    });

    it('deletes the row when its node is removed, and when its flow is deleted', async () => {
        const guildId = newGuild();
        const removedFrom = await scheduledFlow(guildId, { repeat: 'daily', time: '09:00' });
        const deleted = await scheduledFlow(guildId, { repeat: 'daily', time: '10:00' });
        await reconcileGuildSchedules(guildId, at(NOON));
        expect(await rowsOf(guildId)).toHaveLength(2);

        await flowsRepo.update(removedFrom, { graph: graphOf() });
        await reconcileGuildSchedules(guildId, at(NOON));
        expect((await rowsOf(guildId)).map((row) => row.flowId)).toEqual([deleted]);

        await flowsRepo.deleteByFlowId(deleted);
        await reconcileGuildSchedules(guildId, at(NOON));
        expect(await rowsOf(guildId)).toEqual([]);
    });

    it('works out a fresh next time when the server time zone changes', async () => {
        const guildId = newGuild();
        await scheduledFlow(guildId, { repeat: 'daily', time: '09:00' });
        await reconcileGuildSchedules(guildId, at(NOON));

        await guildSettingsRepo.setTimeZone(guildId, 'America/New_York');
        await reconcileGuildSchedules(guildId, at(NOON));

        // 09:00 in New York, daylight time (UTC−4).
        expect((await onlyRow(guildId)).nextRunAt).toEqual(new Date('2026-07-01T13:00:00.000Z'));
    });

    it('keeps an unchanged overdue row on a later reconcile — the startup catch-up', async () => {
        const guildId = newGuild();
        await scheduledFlow(guildId, { repeat: 'daily', time: '09:00' });
        await reconcileGuildSchedules(guildId, at(NOON));

        // The bot was down through 09:00 and comes back the next day.
        await reconcileGuildSchedules(guildId, at(new Date('2026-07-02T20:00:00.000Z')));

        expect((await onlyRow(guildId)).nextRunAt).toEqual(NINE_AM_TODAY);
    });

    it('gives every schedule no next time, with an error naming the guild and zone, for a zone Intl rejects', async () => {
        const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const guildId = newGuild();
        await scheduledFlow(guildId, { repeat: 'daily', time: '09:00' });
        await reconcileGuildSchedules(guildId, at(NOON));

        // Only reachable if the runtime's zone data changes, since the route validates on
        // write — so the bad zone goes straight into the table.
        await guildSettingsRepo.setTimeZone(guildId, 'UTC');
        await database.updateTable('guild_settings').set({ timeZone: 'Mars/Olympus_Mons' }).where('guildId', '=', guildId).execute();
        await reconcileGuildSchedules(guildId, at(NOON));

        expect((await onlyRow(guildId)).nextRunAt).toBeNull();
        expect(error).toHaveBeenCalledWith(expect.stringMatching(new RegExp(`Guild ${guildId}'s time zone "Mars/Olympus_Mons"`)));
    });

    it('skips a node whose settings do not parse, and stops an existing row firing', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const guildId = newGuild();
        const flowId = await scheduledFlow(guildId, { repeat: 'interval' });

        await reconcileGuildSchedules(guildId, at(NOON));
        expect(await rowsOf(guildId)).toEqual([]);
        expect(warn).toHaveBeenCalledWith(expect.stringMatching(/has settings that do not parse/));

        await flowsRepo.update(flowId, { graph: graphOf(scheduleNode({ repeat: 'interval', every: '1h' })) });
        await reconcileGuildSchedules(guildId, at(NOON));
        expect((await onlyRow(guildId)).nextRunAt).toEqual(new Date('2026-07-01T13:00:00.000Z'));

        await flowsRepo.update(flowId, { graph: graphOf(scheduleNode({ repeat: 'interval' })) });
        await reconcileGuildSchedules(guildId, at(NOON));
        expect((await onlyRow(guildId)).nextRunAt).toBeNull();
    });

    it('reads only the fields its repeat shows, so a hidden leftover cannot keep a broken schedule alive', async () => {
        const guildId = newGuild();
        // "Every so often" with a time left over from "Every day", and no interval picked.
        await scheduledFlow(guildId, { repeat: 'interval', time: '09:00' });
        vi.spyOn(console, 'warn').mockImplementation(() => undefined);

        await reconcileGuildSchedules(guildId, at(NOON));

        expect(await rowsOf(guildId)).toEqual([]);
    });

    it('runs one reconcile at a time per guild', async () => {
        const guildId = newGuild();
        await scheduledFlow(guildId, { repeat: 'daily', time: '09:00' });
        const list = vi.spyOn(flowSchedulesRepo, 'listForGuild');
        let inFlight = 0;
        let most = 0;
        list.mockImplementation(async (id) => {
            inFlight += 1;
            most = Math.max(most, inFlight);
            await new Promise((resolve) => setTimeout(resolve, 5));
            inFlight -= 1;
            return database.selectFrom('flow_schedules').selectAll().where('guildId', '=', id).execute();
        });

        await Promise.all([reconcileGuildSchedules(guildId, at(NOON)), reconcileGuildSchedules(guildId, at(NOON))]);
        list.mockRestore();

        expect(most).toBe(1);
        expect(await rowsOf(guildId)).toHaveLength(1);
    });

    it('logs a failure and never throws', async () => {
        const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const read = vi.spyOn(flowsRepo, 'getByGuildId').mockRejectedValueOnce(new Error('db on fire'));

        await expect(reconcileGuildSchedules(newGuild(), at(NOON))).resolves.toBeUndefined();
        read.mockRestore();

        expect(error).toHaveBeenCalledWith(expect.stringMatching(/Could not bring the schedules of guild/), expect.any(Error));
    });

    it('says once that its table is missing, with the fix, rather than per guild and per save', async () => {
        const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        vi.spyOn(flowSchedulesRepo, 'listForGuild').mockRejectedValue(new Error('SqliteError: no such table: flow_schedules'));

        await reconcileGuildSchedules(newGuild(), at(NOON));
        await reconcileGuildSchedules(newGuild(), at(NOON));

        expect(error).toHaveBeenCalledTimes(1);
        expect(error).toHaveBeenCalledWith(expect.stringMatching(/flow_schedules table does not exist.*pnpm migrate:latest/));
    });

    it('stays quiet about a node that does not parse on a switched-off flow — work in progress', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const guildId = newGuild();
        await scheduledFlow(guildId, { repeat: 'interval' }, false);

        await reconcileGuildSchedules(guildId, at(NOON));

        expect(warn).not.toHaveBeenCalled();
        expect(await rowsOf(guildId)).toEqual([]);
    });
});
