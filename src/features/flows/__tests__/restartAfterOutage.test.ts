import { Events } from 'discord.js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { DISCORD_CLIENT } from '../../../discordClient';
import { initActivityTracking, isBackfillPending } from '../../../features-system/activity';
import { clearBackfillPending } from '../../../features-system/activity/backfillState';
import { activityRecorderSessionsRepo } from '../../../features-system/activity/data/activityRecorderSessionsRepo';
import { stopRecorderHeartbeat } from '../../../features-system/activity/recorderSession';
import { database } from '../../../features-system/data-persistence/database';
import { migrateTestDatabase } from '../../../features-system/data-persistence/__tests__/support/migrateTestDatabase';
import { TestDiscord, type ServerMember } from '../../../shared/__tests__/support/testDiscord';
import { ACTION_DELAY } from '../blocks/actionDelay';
import { TRIGGER_MEMBER_JOIN } from '../blocks/triggerMemberJoin';
import { FLOW_GRAPH_VERSION, type FlowGraph } from '../data/flowGraph';
import { flowRunsRepo } from '../data/flowRunsRepo';
import type { FlowQuietWindow, FlowRunEntity } from '../data/flowRunsSchema';
import { flowsRepo } from '../data/flowsRepo';
import { resetFlowRunSchedulerForTests, runFlowRunTick } from '../engine/flowRunScheduler';
import { initFlows } from '../initFlows';

/**
 * A restart after an outage, end to end: the bot's own `DISCORD_CLIENT` against
 * TestDiscord, wired by the real `initActivityTracking()` and `initFlows()` in the order
 * `bot.ts` calls them, on the real migrated schema. Nothing is stubbed — not the repos,
 * not the backfill, not the resume.
 *
 * At ClientReady the recorder session starts backfilling the outage from Discord's
 * history while the scheduler's startup sweep runs straight away. The sweep must not
 * time out a quiet-window run on history the backfill is about to restore.
 *
 * One restart for the whole file, three runs in it, because there is only one restart
 * to be had: `DISCORD_CLIENT` cannot be handshaken twice, `initActivityTracking` wires
 * once, and `initFlows` is memoized. Each run below is the subject of one case.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const NOW = Date.now();

/** The previous process: up from five hours ago until its last heartbeat, three hours ago. */
const PREVIOUS_STARTED_AT = new Date(NOW - 5 * HOUR);
const OUTAGE_STARTED_AT = new Date(NOW - 3 * HOUR);

/**
 * Every run parked four hours ago, while the bot was still up, so each falls due two
 * hours ago — in the middle of the outage.
 */
const QUIET_WINDOW_MS = 2 * HOUR;
const WAKE_AT = new Date(NOW - 2 * HOUR);

/** What the chatty member said while the bot was down: inside the gap, after the park. */
const SPOKEN_DURING_OUTAGE_AT = new Date(NOW - HOUR);

const discord = new TestDiscord();
/** Whether activity was still backfilling each time the scheduler asked for due runs. */
const backfillPendingAtEachPoll: boolean[] = [];

let chattyRun: FlowRunEntity;
let silentRun: FlowRunEntity;
let plainRun: FlowRunEntity;

/** Join → Delay, with nothing after it: a resumed run simply completes. */
function delayGraph(channelId: string): FlowGraph {
    return {
        version: FLOW_GRAPH_VERSION,
        nodes: [
            { id: 'trigger', type: TRIGGER_MEMBER_JOIN, position: { x: 0, y: 0 }, data: {} },
            {
                id: 'wait',
                type: ACTION_DELAY,
                position: { x: 200, y: 0 },
                data: { durationMs: QUIET_WINDOW_MS, timeoutCountsFrom: 'memberMessage', quietChannelId: channelId },
            },
        ],
        edges: [{ id: 'e1', source: 'trigger', target: 'wait' }],
    };
}

async function parkRun(
    flowId: string,
    guildId: string,
    member: ServerMember,
    quietWindow: FlowQuietWindow | null
): Promise<FlowRunEntity> {
    return flowRunsRepo.create({
        flowId,
        guildId,
        contextSnapshot: { guildId, userId: member.id },
        resumeNodeId: 'wait',
        wakeAt: WAKE_AT,
        quietWindow,
        visitsUsed: 2,
        log: [{ nodeId: 'wait', type: ACTION_DELAY, kind: 'action', status: 'ok' }],
    });
}

async function current(run: FlowRunEntity): Promise<FlowRunEntity | null> {
    return flowRunsRepo.getByRunId(run.runId);
}

beforeAll(async () => {
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    await migrateTestDatabase();

    // Before the outage: the previous process's session, filled as the first one ever is.
    const previous = await activityRecorderSessionsRepo.open(PREVIOUS_STARTED_AT);
    await activityRecorderSessionsRepo.heartbeat(previous, OUTAGE_STARTED_AT);

    const guild = discord.createGuild();
    const channel = guild.createTextChannel({ name: 'dungeon' });
    const chatty = guild.createMember({ username: 'kept_talking' });
    const silent = guild.createMember({ username: 'went_quiet' });
    const plain = guild.createMember({ username: 'on_a_timer' });

    const flow = await flowsRepo.create({ guildId: guild.id, name: 'Gone quiet', graph: delayGraph(channel.id) });
    const window: FlowQuietWindow = { durationMs: QUIET_WINDOW_MS, who: 'member', channelId: channel.id };
    chattyRun = await parkRun(flow.flowId, guild.id, chatty, window);
    silentRun = await parkRun(flow.flowId, guild.id, silent, window);
    plainRun = await parkRun(flow.flowId, guild.id, plain, null);

    // History the live recorder never heard: sent while the bot was down.
    channel.receiveMessage({ from: chatty, content: 'still here, still bratty', sentAt: SPOKEN_DURING_OUTAGE_AT });

    const findDue = flowRunsRepo.findDue.bind(flowRunsRepo);
    vi.spyOn(flowRunsRepo, 'findDue').mockImplementation((...args) => {
        backfillPendingAtEachPoll.push(isBackfillPending());
        return findDue(...args);
    });

    // In bot.ts order, then the restart itself: ClientReady fires inside `start`.
    initActivityTracking();
    await initFlows();
    await discord.start({ client: DISCORD_CLIENT });

    // The startup sweep resumes what was not waiting on history.
    await vi.waitFor(async () => expect((await current(plainRun))?.status).toBe('completed'));
    await vi.waitFor(() => expect(isBackfillPending()).toBe(false));

    // The scheduler's next tick, driven by hand rather than waiting out the 15s interval.
    // Retried because a tick still running from the sweep makes this one skip.
    await vi.waitFor(async () => {
        await runFlowRunTick(DISCORD_CLIENT);
        expect((await current(silentRun))?.status).toBe('completed');
    });
}, 30_000);

afterAll(async () => {
    resetFlowRunSchedulerForTests();
    stopRecorderHeartbeat();
    clearBackfillPending();
    for (const event of [
        Events.ClientReady,
        Events.MessageCreate,
        Events.MessageReactionAdd,
        Events.GuildMemberAdd,
        Events.GuildMemberRemove,
    ] as const) {
        DISCORD_CLIENT.removeAllListeners(event);
    }
    vi.restoreAllMocks();
    await discord.destroy();
});

describe('restarting after an outage', () => {
    it('defers a quiet-window run on the message the backfill recovered, rather than timing it out', async () => {
        // The premise: the sweep asked for due runs while the backfill was still running.
        expect(backfillPendingAtEachPoll[0]).toBe(true);

        const after = await current(chattyRun);
        expect(after?.status).toBe('suspended');
        expect(after?.wakeAt).toEqual(new Date(SPOKEN_DURING_OUTAGE_AT.getTime() + QUIET_WINDOW_MS));
        expect(after?.visitsUsed).toBe(chattyRun.visitsUsed);

        const recovered = await database.selectFrom('activity_events').selectAll().execute();
        expect(recovered).toEqual([
            expect.objectContaining({ userId: chattyRun.contextSnapshot.userId, occurredAt: SPOKEN_DURING_OUTAGE_AT }),
        ]);
    });

    it('times out a quiet-window run whose member said nothing, once the backfill has finished', async () => {
        expect((await current(silentRun))?.status).toBe('completed');
        expect(await activityRecorderSessionsRepo.findUnfilled()).toEqual([]);
    });

    it('resumes a plain delay on the startup sweep without waiting for the backfill', async () => {
        expect((await current(plainRun))?.status).toBe('completed');
    });
});
