import { Events } from 'discord.js';
import { afterAll, beforeAll, describe, expect, it, vi, type MockInstance } from 'vitest';
import { DISCORD_CLIENT } from '../../../discordClient';
import { activityEventsRepo, initActivityTracking, isBackfillPending } from '../../../features-system/activity';
import { clearBackfillPending } from '../../../features-system/activity/backfillState';
import { activityRecorderSessionsRepo } from '../../../features-system/activity/data/activityRecorderSessionsRepo';
import { stopRecorderHeartbeat } from '../../../features-system/activity/recorderSession';
import { migrateTestDatabase } from '../../../features-system/data-persistence/__tests__/support/migrateTestDatabase';
import { TestDiscord, type ServerMember } from '../../../shared/__tests__/support/testDiscord';
import { ACTION_SET_VARIABLE } from '../blocks/actionSetVariable';
import { ACTION_WAIT_FOR_EVENT, WAIT_TIMEOUT_HANDLE } from '../blocks/actionWaitForEvent';
import { TRIGGER_MEMBER_JOIN } from '../blocks/triggerMemberJoin';
import { FLOW_GRAPH_VERSION, type FlowGraph, type FlowNode } from '../data/flowGraph';
import { flowRunsRepo, type FindDueOptions } from '../data/flowRunsRepo';
import type { FlowRunEntity } from '../data/flowRunsSchema';
import { flowsRepo } from '../data/flowsRepo';
import { resetFlowRunSchedulerForTests, runFlowRunTick } from '../engine/flowRunScheduler';
import { messageActivityLimit, type MessageActivityLimit } from '../engine/messageActivityLimit';
import { rebuildMessageWaitIndex, resumeMessageWaitsAfterBackfill } from '../engine/messageWaitDispatch';
import { initFlows } from '../initFlows';

/**
 * Replies sent while the bot was down, end to end: runs parked on a message wait before
 * an outage, members answering (or not) during it, and a restart. The bot's own
 * `DISCORD_CLIENT` against TestDiscord, wired by the real `initActivityTracking()` and
 * `initFlows()` in `bot.ts` order, on the real migrated schema; nothing is stubbed.
 *
 * At ClientReady the backfill restores the outage's messages while the scheduler's startup
 * sweep runs. The sweep must hold every message wait — even one whose deadline passed
 * during the outage — until the catch-up has looked for its reply.
 *
 * One restart for the whole file, as in `restartAfterOutage.test.ts`; each run below is
 * the subject of one case.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const NOW = Date.now();

/** The previous process: up from five hours ago until its last heartbeat, three hours ago. */
const PREVIOUS_STARTED_AT = new Date(NOW - 5 * HOUR);
const OUTAGE_STARTED_AT = new Date(NOW - 3 * HOUR);

/** Every run parked four hours ago, while the bot was up. Limited waits fell due two hours ago, mid-outage. */
const PARKED_AT = new Date(NOW - 4 * HOUR);
const LIMIT_MS = 2 * HOUR;
const DEADLINE = new Date(NOW - 2 * HOUR);

const discord = new TestDiscord();
/** What each poll for due runs asked for, and whether activity was still backfilling then. */
const polls: { options: FindDueOptions | undefined; backfillPending: boolean }[] = [];

let repliedNoLimit: FlowRunEntity;
let repliedInTime: FlowRunEntity;
let repliedTooLate: FlowRunEntity;
let silentNoLimit: FlowRunEntity;
let silentLimited: FlowRunEntity;
let stranded: FlowRunEntity;
/** Every draw on the message flood limit — which the catch-up must never make. */
let limitDraws: MockInstance<MessageActivityLimit['take']>;
/** A flow that waits for a message again after each one, parked on by hand after startup. */
let looping: { guildId: string; channelId: string; flowId: string; member: ServerMember };

function mark(id: string): FlowNode {
    return {
        id,
        type: ACTION_SET_VARIABLE,
        position: { x: 0, y: 0 },
        data: { variableName: id, valueType: 'text', textValue: 'yes' },
    };
}

/** join → wait for a message in the channel → `after` → back to the wait. */
function loopGraph(channelId: string): FlowGraph {
    return {
        version: FLOW_GRAPH_VERSION,
        nodes: [
            { id: 'trigger', type: TRIGGER_MEMBER_JOIN, position: { x: 0, y: 0 }, data: {} },
            { id: 'wait', type: ACTION_WAIT_FOR_EVENT, position: { x: 0, y: 0 }, data: { eventKind: 'message', messageChannelId: channelId } },
            mark('after'),
        ],
        edges: [
            { id: 'e1', source: 'trigger', target: 'wait' },
            { id: 'e2', source: 'wait', target: 'after' },
            { id: 'e3', source: 'after', target: 'wait' },
        ],
    };
}

/** join → wait for a message in the channel (optionally with a limit) → `after`, or `late` on timeout. */
function waitGraph(channelId: string, limited: boolean): FlowGraph {
    return {
        version: FLOW_GRAPH_VERSION,
        nodes: [
            { id: 'trigger', type: TRIGGER_MEMBER_JOIN, position: { x: 0, y: 0 }, data: {} },
            {
                id: 'wait',
                type: ACTION_WAIT_FOR_EVENT,
                position: { x: 0, y: 0 },
                data: { eventKind: 'message', messageChannelId: channelId, ...(limited ? { timeoutMs: LIMIT_MS } : {}) },
            },
            mark('after'),
            ...(limited ? [mark('late')] : []),
        ],
        edges: [
            { id: 'e1', source: 'trigger', target: 'wait' },
            { id: 'e2', source: 'wait', target: 'after' },
            ...(limited ? [{ id: 'e3', source: 'wait', sourceHandle: WAIT_TIMEOUT_HANDLE, target: 'late' }] : []),
        ],
    };
}

async function parkOnMessage(
    flowId: string,
    guildId: string,
    channelId: string,
    member: ServerMember,
    limited: boolean
): Promise<FlowRunEntity> {
    return flowRunsRepo.create({
        flowId,
        guildId,
        contextSnapshot: { guildId, userId: member.id },
        resumeNodeId: 'wait',
        wakeAt: limited ? DEADLINE : null,
        waitKind: 'message',
        waitConfig: {
            eventKind: 'message',
            channelId,
            parkedAt: PARKED_AT.toISOString(),
            ...(limited ? { timeoutMs: LIMIT_MS } : {}),
        },
        visitsUsed: 2,
        log: [{ nodeId: 'wait', type: ACTION_WAIT_FOR_EVENT, kind: 'action', status: 'ok' }],
    });
}

async function current(run: FlowRunEntity): Promise<FlowRunEntity> {
    const row = await flowRunsRepo.getByRunId(run.runId);
    if (!row) throw new Error(`run ${run.runId} vanished`);
    return row;
}

/** Which of `after` and `late` the run went on to, or none while it is still parked. */
async function exitTaken(run: FlowRunEntity): Promise<'after' | 'late' | 'none'> {
    const visited = (await current(run)).log.map((entry) => entry.nodeId);
    if (visited.includes('after')) return 'after';
    if (visited.includes('late')) return 'late';
    return 'none';
}

beforeAll(async () => {
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await migrateTestDatabase();

    const previous = await activityRecorderSessionsRepo.open(PREVIOUS_STARTED_AT);
    await activityRecorderSessionsRepo.heartbeat(previous, OUTAGE_STARTED_AT);

    const guild = discord.createGuild();
    const channel = guild.createTextChannel({ name: 'ticket-0069' });
    const thread = guild.createThread({ parent: channel, name: 'side-quest' });
    const members = {
        alice: guild.createMember({ username: 'answered_eventually' }),
        bob: guild.createMember({ username: 'answered_in_time' }),
        carol: guild.createMember({ username: 'answered_too_late' }),
        dave: guild.createMember({ username: 'ghosted_forever' }),
        erin: guild.createMember({ username: 'ghosted_on_a_timer' }),
        frank: guild.createMember({ username: 'stranded_mid_resume' }),
        grace: guild.createMember({ username: 'answers_in_circles' }),
    };

    const noLimit = await flowsRepo.create({ guildId: guild.id, name: 'Waits forever', graph: waitGraph(channel.id, false) });
    const limited = await flowsRepo.create({ guildId: guild.id, name: 'Waits two hours', graph: waitGraph(channel.id, true) });
    const loop = await flowsRepo.create({ guildId: guild.id, name: 'Never satisfied', graph: loopGraph(channel.id) });
    looping = { guildId: guild.id, channelId: channel.id, flowId: loop.flowId, member: members.grace };

    repliedNoLimit = await parkOnMessage(noLimit.flowId, guild.id, channel.id, members.alice, false);
    repliedInTime = await parkOnMessage(limited.flowId, guild.id, channel.id, members.bob, true);
    repliedTooLate = await parkOnMessage(limited.flowId, guild.id, channel.id, members.carol, true);
    silentNoLimit = await parkOnMessage(noLimit.flowId, guild.id, channel.id, members.dave, false);
    silentLimited = await parkOnMessage(limited.flowId, guild.id, channel.id, members.erin, true);
    // Claimed by the previous process, which died before it could finish: `running`, not parked.
    stranded = await parkOnMessage(noLimit.flowId, guild.id, channel.id, members.frank, false);
    await flowRunsRepo.claimForResume(stranded.runId);

    // History the live recorder never heard: sent while the bot was down.
    channel.receiveMessage({ from: members.alice, content: 'sorry, was tied up', sentAt: new Date(NOW - HOUR) });
    channel.receiveMessage({ from: members.bob, content: 'made it', sentAt: new Date(NOW - 150 * MINUTE) });
    channel.receiveMessage({ from: members.carol, content: 'oops, overslept', sentAt: new Date(NOW - HOUR) });
    thread.receiveMessage({ from: members.frank, content: 'replying in the thread', sentAt: new Date(NOW - HOUR) });

    const findDue = flowRunsRepo.findDue.bind(flowRunsRepo);
    vi.spyOn(flowRunsRepo, 'findDue').mockImplementation((now, options) => {
        polls.push({ options, backfillPending: isBackfillPending() });
        return findDue(now, options);
    });
    limitDraws = vi.spyOn(messageActivityLimit, 'take');

    initActivityTracking();
    await initFlows();
    await discord.start({ client: DISCORD_CLIENT });

    // The catch-up wakes the three that answered in time, once the backfill has restored it.
    await vi.waitFor(async () => {
        expect(isBackfillPending()).toBe(false);
        for (const run of [repliedNoLimit, repliedInTime, stranded]) {
            expect((await current(run)).status).toBe('completed');
        }
    }, { timeout: 10_000 });

    // Then the scheduler's next tick times out what is still due, driven by hand rather than
    // waiting out the interval, and retried because a tick still running makes this one skip.
    await vi.waitFor(async () => {
        await runFlowRunTick(DISCORD_CLIENT);
        expect((await current(repliedTooLate)).status).toBe('completed');
        expect((await current(silentLimited)).status).toBe('completed');
    }, { timeout: 10_000 });
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

describe('replies sent to a message wait while the bot was down', () => {
    it('held every message wait from the startup sweep, while the backfill was still running', () => {
        expect(polls[0]).toEqual({
            options: expect.objectContaining({ withoutMessageWaits: true }),
            backfillPending: true,
        });
    });

    it('wakes a wait with no limit on the reply the backfill recovered', async () => {
        expect(await exitTaken(repliedNoLimit)).toBe('after');
    });

    it('takes the happened exit for a reply sent before a deadline that passed during the outage', async () => {
        expect(await exitTaken(repliedInTime)).toBe('after');
    });

    it('times out a wait whose only reply came after its deadline', async () => {
        expect(await exitTaken(repliedTooLate)).toBe('late');
    });

    it('leaves a wait with no limit and no reply parked, and times out one whose limit has passed', async () => {
        expect((await current(silentNoLimit)).status).toBe('suspended');
        expect(await exitTaken(silentLimited)).toBe('late');
    });

    it('wakes a run a dead process left mid-resume, on a reply in a thread under the channel', async () => {
        expect(await exitTaken(stranded)).toBe('after');
    });

    it('never draws from the message flood limit — a recovered reply the member really sent is never dropped', () => {
        expect(limitDraws).not.toHaveBeenCalled();
    });

    it('re-parks a run it woke after the recovered reply, so the next restart cannot wake it on the same one', async () => {
        const { guildId, channelId, flowId, member } = looping;
        // Parked by hand, after startup, so only the catch-ups below ever see it.
        const run = await parkOnMessage(flowId, guildId, channelId, member, false);
        const repliedAt = new Date(NOW - 30 * MINUTE);
        await activityEventsRepo.record({
            guildId,
            userId: member.id,
            channelId,
            parentChannelId: null,
            messageId: null,
            kind: 'message',
            occurredAt: repliedAt,
        });
        await rebuildMessageWaitIndex(flowRunsRepo);

        // The bot's clock reading the reply's own instant while it wakes the run: the one
        // moment a wait parked at "now" would listen from the reply rather than after it.
        const clock = vi.spyOn(Date, 'now').mockReturnValue(repliedAt.getTime());
        let woken: number;
        try {
            woken = await resumeMessageWaitsAfterBackfill(DISCORD_CLIENT, activityEventsRepo);
        } finally {
            clock.mockRestore();
        }
        expect(woken).toBe(1);

        const reparked = await current(run);
        expect(reparked.status).toBe('suspended');
        expect(reparked.resumeNodeId).toBe('wait');
        expect(reparked.waitConfig).toMatchObject({ eventKind: 'message', parkedAt: new Date(repliedAt.getTime() + 1).toISOString() });

        // Another restart, and nothing new said: the reply that woke it is behind its wait.
        await rebuildMessageWaitIndex(flowRunsRepo);
        expect(await resumeMessageWaitsAfterBackfill(DISCORD_CLIENT, activityEventsRepo)).toBe(0);
        expect((await current(run)).visitsUsed).toBe(reparked.visitsUsed);
    });
});
