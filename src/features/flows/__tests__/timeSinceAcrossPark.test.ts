import { Events } from 'discord.js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { DISCORD_CLIENT } from '../../../discordClient';
import { database } from '../../../features-system/data-persistence/database';
import { migrateTestDatabase } from '../../../features-system/data-persistence/__tests__/support/migrateTestDatabase';
import { TestDiscord } from '../../../shared/__tests__/support/testDiscord';
import { ACTION_DELAY } from '../blocks/actionDelay';
import { ACTION_SET_VARIABLE } from '../blocks/actionSetVariable';
import { CONDITION_TIME_SINCE } from '../blocks/conditionTimeSince';
import { TRIGGER_MEMBER_JOIN } from '../blocks/triggerMemberJoin';
import { FLOW_GRAPH_VERSION, type FlowGraph } from '../data/flowGraph';
import { flowRunsRepo } from '../data/flowRunsRepo';
import type { FlowRunEntity } from '../data/flowRunsSchema';
import { flowsRepo } from '../data/flowsRepo';
import { resetFlowRunSchedulerForTests, runFlowRunTick } from '../engine/flowRunScheduler';
import { initFlows } from '../initFlows';

/**
 * A saved time and the run's own start, both read a day later on the far side of a park
 * — end to end, with nothing stubbed.
 *
 * The bot's own `DISCORD_CLIENT` against TestDiscord, wired by the real `initFlows()`, on
 * the real migrated schema: a member joins, Set Variable stamps `seenAt` with the current
 * time, a Delay parks the run for a day, and the scheduler's tick resumes it through the
 * real resume path. Then two Time Since checks, one on `seenAt` and one on "When this run
 * started", must each leave by Yes.
 *
 * Both values have to survive the park to answer at all: the bag rides the row and is
 * reseeded on resume, and the start time is written into the snapshot at the first park
 * and handed back. Lose either and the check leaves by No record instead — so the branch
 * each one took, read off the finished run's log, is the proof.
 *
 * Only `Date` is faked, and only once the run has parked: the scheduler's interval,
 * `vi.waitFor` and discord.js keep real timers. The jump is a day plus a margin, because
 * the run's start is taken as the trigger fires, a moment before `seenAt` is written.
 */

const DAY = 24 * 60 * 60 * 1000;
const MARGIN = 60_000;

const discord = new TestDiscord();
let run: FlowRunEntity;

/** join -> stamp seenAt -> wait a day -> seenAt a day ago? -> run started a day ago? */
const graph: FlowGraph = {
    version: FLOW_GRAPH_VERSION,
    nodes: [
        { id: 'joined', type: TRIGGER_MEMBER_JOIN, position: { x: 0, y: 0 }, data: {} },
        {
            id: 'stamp',
            type: ACTION_SET_VARIABLE,
            position: { x: 0, y: 120 },
            data: { variableName: 'seenAt', valueType: 'time' },
        },
        { id: 'wait', type: ACTION_DELAY, position: { x: 0, y: 240 }, data: { durationMs: DAY } },
        {
            id: 'sinceSeen',
            type: CONDITION_TIME_SINCE,
            position: { x: 0, y: 360 },
            data: { source: 'variable', timeVariable: 'seenAt', comparison: 'atLeast', durationMs: DAY },
        },
        {
            id: 'sinceStart',
            type: CONDITION_TIME_SINCE,
            position: { x: 0, y: 480 },
            data: { source: 'runStarted', comparison: 'atLeast', durationMs: DAY },
        },
    ],
    edges: [
        { id: 'e1', source: 'joined', target: 'stamp' },
        { id: 'e2', source: 'stamp', target: 'wait' },
        { id: 'e3', source: 'wait', target: 'sinceSeen' },
        { id: 'e4', source: 'sinceSeen', sourceHandle: 'true', target: 'sinceStart' },
    ],
};

async function current(): Promise<FlowRunEntity | null> {
    return flowRunsRepo.getByRunId(run.runId);
}

beforeAll(async () => {
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await migrateTestDatabase();

    const guild = discord.createGuild();
    await flowsRepo.create({ guildId: guild.id, name: 'Long time no see', graph, enabled: true });

    await initFlows();
    await discord.start({ client: DISCORD_CLIENT });

    // The join starts the run, which parks at the delay.
    const member = guild.createMember({ username: 'fashionably_late' });
    await vi.waitFor(async () => {
        const [parked] = await database.selectFrom('flow_runs').select('runId').execute();
        expect(parked).toBeDefined();
        const row = parked ? await flowRunsRepo.getByRunId(parked.runId) : null;
        expect(row?.status).toBe('suspended');
        run = row as FlowRunEntity;
    }, { timeout: 10_000 });
    expect(run.contextSnapshot.userId).toBe(member.id);

    // A day later — on the clock only. Then the scheduler's next tick, driven by hand
    // rather than waiting out its interval, and retried because a tick still running
    // from the startup sweep makes this one skip.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(Date.now() + DAY + MARGIN));
    await vi.waitFor(async () => {
        await runFlowRunTick(DISCORD_CLIENT);
        expect((await current())?.status).toBe('completed');
    }, { timeout: 10_000 });
}, 30_000);

afterAll(async () => {
    vi.useRealTimers();
    resetFlowRunSchedulerForTests();
    for (const event of [Events.ClientReady, Events.GuildMemberAdd, Events.GuildMemberRemove] as const) {
        DISCORD_CLIENT.removeAllListeners(event);
    }
    vi.restoreAllMocks();
    await discord.destroy();
});

describe('a saved time and the run start, a day and a park later', () => {
    it('parked with the stamp in the bag and the start in the snapshot', () => {
        const seenAt = run.variables.seenAt;
        const startedAt = run.contextSnapshot.startedAt;

        expect(typeof seenAt).toBe('string');
        expect(new Date(String(seenAt)).toISOString()).toBe(seenAt);
        expect(startedAt).toBeDefined();
        expect(Date.parse(String(seenAt))).toBeGreaterThanOrEqual(Date.parse(String(startedAt)));
    });

    it('left both checks by Yes once it woke', async () => {
        const finished = await current();
        const branches = (finished?.log ?? [])
            .filter((entry) => entry.type === CONDITION_TIME_SINCE)
            .map((entry) => ({ nodeId: entry.nodeId, status: entry.status, branch: entry.branch }));

        expect(branches).toEqual([
            { nodeId: 'sinceSeen', status: 'ok', branch: 'true' },
            { nodeId: 'sinceStart', status: 'ok', branch: 'true' },
        ]);
    });
});
