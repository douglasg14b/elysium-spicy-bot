import { Events } from 'discord.js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { DISCORD_CLIENT } from '../../../discordClient';
import { initActivityTracking } from '../../../features-system/activity';
import { clearBackfillPending } from '../../../features-system/activity/backfillState';
import { stopRecorderHeartbeat } from '../../../features-system/activity/recorderSession';
import { database } from '../../../features-system/data-persistence/database';
import { migrateTestDatabase } from '../../../features-system/data-persistence/__tests__/support/migrateTestDatabase';
import {
    TestDiscord,
    type ServerChannel,
    type ServerGuild,
    type ServerMember,
    type ServerThread,
} from '../../../shared/__tests__/support/testDiscord';
import { ACTION_DELAY } from '../blocks/actionDelay';
import { ACTION_SET_VARIABLE } from '../blocks/actionSetVariable';
import { ACTION_WAIT_FOR_EVENT, WAIT_TIMEOUT_HANDLE } from '../blocks/actionWaitForEvent';
import { TRIGGER_MEMBER_JOIN } from '../blocks/triggerMemberJoin';
import { FLOW_GRAPH_VERSION, type FlowEdge, type FlowGraph, type FlowNode } from '../data/flowGraph';
import { flowRunsRepo } from '../data/flowRunsRepo';
import type { FlowRunEntity } from '../data/flowRunsSchema';
import { flowsRepo } from '../data/flowsRepo';
import { messageWaitIndex } from '../engine/messageWaitIndex';
import { resetFlowRunSchedulerForTests, runFlowRunTick } from '../engine/flowRunScheduler';
import { initFlows } from '../initFlows';

/**
 * Wait for Event's message kind, live and end to end: the bot's own `DISCORD_CLIENT`
 * against TestDiscord, wired by the real `initActivityTracking()` and `initFlows()` in
 * `bot.ts` order, on the real migrated schema. Members join (starting a run that parks on
 * the wait) and then post; the real recorder hands each message to the real subscriber.
 *
 * One guild per case, all built before the client starts — TestDiscord can only create
 * threads before `start()`, and a guild's flows start on every join in it.
 */

const HOUR = 60 * 60_000;
const WAIT_FOR = { timeout: 10_000 };

const discord = new TestDiscord();
const claims = vi.spyOn(flowRunsRepo, 'claimForResume');

function graph(nodes: FlowNode[], edges: FlowEdge[]): FlowGraph {
    return {
        version: FLOW_GRAPH_VERSION,
        nodes: [{ id: 'trigger', type: TRIGGER_MEMBER_JOIN, position: { x: 0, y: 0 }, data: {} }, ...nodes],
        edges,
    };
}

function node(id: string, type: string, data: Record<string, unknown>): FlowNode {
    return { id, type, position: { x: 0, y: 0 }, data };
}

function mark(id: string): FlowNode {
    return node(id, ACTION_SET_VARIABLE, { variableName: id, valueType: 'text', textValue: 'yes' });
}

/** join → wait for a message (with `waitData`) → `after`. */
function waitThenAfter(waitData: Record<string, unknown>): FlowGraph {
    return graph(
        [node('wait', ACTION_WAIT_FOR_EVENT, { eventKind: 'message', ...waitData }), mark('after')],
        [
            { id: 'e1', source: 'trigger', target: 'wait' },
            { id: 'e2', source: 'wait', target: 'after' },
        ]
    );
}

type Scenario = { guild: ServerGuild; flowId: string };

async function scenario(build: (guild: ServerGuild) => FlowGraph): Promise<Scenario> {
    const guild = discord.createGuild();
    const flow = await flowsRepo.create({ guildId: guild.id, name: 'Talk to me', graph: build(guild), enabled: true });
    return { guild, flowId: flow.flowId };
}

/** The run a member's join started, once it has parked at `nodeId`. */
async function parkedRun(flowId: string, member: ServerMember, nodeId = 'wait'): Promise<FlowRunEntity> {
    let parked: FlowRunEntity | undefined;
    await vi.waitFor(async () => {
        const rows = await database.selectFrom('flow_runs').select('runId').where('flowId', '=', flowId).execute();
        const runs = await Promise.all(rows.map((row) => flowRunsRepo.getByRunId(row.runId)));
        parked = runs.find((run) => run?.contextSnapshot.userId === member.id) ?? undefined;
        expect(parked?.status).toBe('suspended');
        expect(parked?.resumeNodeId).toBe(nodeId);
    }, WAIT_FOR);
    return parked as FlowRunEntity;
}

async function current(run: FlowRunEntity): Promise<FlowRunEntity> {
    const row = await flowRunsRepo.getByRunId(run.runId);
    if (!row) throw new Error(`run ${run.runId} vanished`);
    return row;
}

async function completedThrough(run: FlowRunEntity, nodeId: string): Promise<void> {
    await vi.waitFor(async () => {
        const row = await current(run);
        expect(row.status).toBe('completed');
        expect(row.log.map((entry) => entry.nodeId)).toContain(nodeId);
    }, WAIT_FOR);
}

/** Every claim attempt for this run so far, each awaited to what it returned. */
async function claimsFor(run: FlowRunEntity): Promise<(FlowRunEntity | null)[]> {
    const attempts = claims.mock.calls.flatMap(([runId], index) =>
        runId === run.runId ? [claims.mock.results[index]?.value as Promise<FlowRunEntity | null>] : []
    );
    return Promise.all(attempts);
}

/** Until activity has recorded `count` messages from this member, so the subscriber has been handed each. */
async function recorded(member: ServerMember, count: number): Promise<void> {
    await vi.waitFor(async () => {
        const rows = await database.selectFrom('activity_events').select('id').where('userId', '=', member.id).execute();
        expect(rows).toHaveLength(count);
    }, WAIT_FOR);
    // The subscriber runs straight after the write; let its claim, if any, be issued.
    await new Promise((resolve) => setTimeout(resolve, 50));
}

let inChannel: Scenario & { dungeon: ServerChannel; lounge: ServerChannel; thread: ServerThread; bystander: ServerMember };
let anywhere: Scenario & { lounge: ServerChannel };
let fromVariable: Scenario & { watched: ServerChannel; other: ServerChannel };
let timed: Scenario & { lounge: ServerChannel };
let looping: Scenario & { lounge: ServerChannel };
let delayed: Scenario & { lounge: ServerChannel };
let released: Scenario & { lounge: ServerChannel };

beforeAll(async () => {
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await migrateTestDatabase();

    let dungeon!: ServerChannel;
    const channelScenario = await scenario((guild) => {
        dungeon = guild.createTextChannel({ name: 'dungeon' });
        return waitThenAfter({ messageChannelId: dungeon.id });
    });
    inChannel = {
        ...channelScenario,
        dungeon,
        lounge: channelScenario.guild.createTextChannel({ name: 'lounge' }),
        thread: channelScenario.guild.createThread({ parent: dungeon, name: 'aftercare' }),
        // Already a member before the bot starts, so no run of their own.
        bystander: channelScenario.guild.createMember({ username: 'nosy_neighbour' }),
    };

    const anywhereScenario = await scenario(() => waitThenAfter({}));
    anywhere = { ...anywhereScenario, lounge: anywhereScenario.guild.createTextChannel({ name: 'lounge' }) };

    let watched!: ServerChannel;
    const variableScenario = await scenario((guild) => {
        watched = guild.createTextChannel({ name: 'confessional' });
        return graph(
            [
                node('remember', ACTION_SET_VARIABLE, { variableName: 'watched', valueType: 'text', textValue: watched.id }),
                node('wait', ACTION_WAIT_FOR_EVENT, { eventKind: 'message', messageChannelId: '{{var.watched}}' }),
                mark('after'),
            ],
            [
                { id: 'e1', source: 'trigger', target: 'remember' },
                { id: 'e2', source: 'remember', target: 'wait' },
                { id: 'e3', source: 'wait', target: 'after' },
            ]
        );
    });
    fromVariable = { ...variableScenario, watched, other: variableScenario.guild.createTextChannel({ name: 'elsewhere' }) };

    const timedScenario = await scenario(() =>
        graph(
            [node('wait', ACTION_WAIT_FOR_EVENT, { eventKind: 'message', timeoutMs: HOUR }), mark('after'), mark('late')],
            [
                { id: 'e1', source: 'trigger', target: 'wait' },
                { id: 'e2', source: 'wait', target: 'after' },
                { id: 'e3', source: 'wait', sourceHandle: WAIT_TIMEOUT_HANDLE, target: 'late' },
            ]
        )
    );
    timed = { ...timedScenario, lounge: timedScenario.guild.createTextChannel({ name: 'lounge' }) };

    // wait → after → back to the same wait, so every message is answered and re-parked.
    const loopScenario = await scenario(() =>
        graph(
            [node('wait', ACTION_WAIT_FOR_EVENT, { eventKind: 'message' }), mark('after')],
            [
                { id: 'e1', source: 'trigger', target: 'wait' },
                { id: 'e2', source: 'wait', target: 'after' },
                { id: 'e3', source: 'after', target: 'wait' },
            ]
        )
    );
    looping = { ...loopScenario, lounge: loopScenario.guild.createTextChannel({ name: 'lounge' }) };

    const delayScenario = await scenario(() =>
        graph(
            [node('delay', ACTION_DELAY, { durationMs: HOUR }), mark('after')],
            [
                { id: 'e1', source: 'trigger', target: 'delay' },
                { id: 'e2', source: 'delay', target: 'after' },
            ]
        )
    );
    delayed = { ...delayScenario, lounge: delayScenario.guild.createTextChannel({ name: 'lounge' }) };

    const releaseScenario = await scenario(() => waitThenAfter({}));
    released = { ...releaseScenario, lounge: releaseScenario.guild.createTextChannel({ name: 'lounge' }) };

    initActivityTracking();
    await initFlows();
    await discord.start({ client: DISCORD_CLIENT });
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

describe('waiting for a message from the member', () => {
    it('wakes on their message in the channel, and ignores other members and other channels', async () => {
        const member = inChannel.guild.createMember({ username: 'finally_talking' });
        const run = await parkedRun(inChannel.flowId, member);

        inChannel.dungeon.receiveMessage({ from: inChannel.bystander, content: 'not you, darling' });
        inChannel.lounge.receiveMessage({ from: member, content: 'wrong room' });
        await recorded(member, 1);

        expect(await claimsFor(run)).toEqual([]);
        expect((await current(run)).status).toBe('suspended');

        inChannel.dungeon.receiveMessage({ from: member, content: 'here, sir' });
        await completedThrough(run, 'after');
    });

    it('wakes on their reply in a thread under the channel', async () => {
        const member = inChannel.guild.createMember({ username: 'thread_lurker' });
        const run = await parkedRun(inChannel.flowId, member);

        inChannel.thread.receiveMessage({ from: member, content: 'replying in the thread like a coward' });

        await completedThrough(run, 'after');
    });

    it('wakes on their message anywhere when no channel is set', async () => {
        const member = anywhere.guild.createMember({ username: 'anywhere_will_do' });
        const run = await parkedRun(anywhere.flowId, member);
        expect(messageWaitIndex.get(run.runId)).toMatchObject({ guildId: anywhere.guild.id, userId: member.id });

        anywhere.lounge.receiveMessage({ from: member, content: 'hi' });

        await completedThrough(run, 'after');
        // The claim took it out of the index; nothing re-parked it.
        expect(messageWaitIndex.get(run.runId)).toBeUndefined();
    });

    it('listens in the channel a {{var}} resolved to, and records it with when it parked', async () => {
        const before = Date.now();
        const member = fromVariable.guild.createMember({ username: 'variable_subject' });
        const run = await parkedRun(fromVariable.flowId, member);

        expect(run.waitKind).toBe('message');
        expect(run.waitConfig).toEqual({ eventKind: 'message', channelId: fromVariable.watched.id, parkedAt: expect.any(String) });
        const parkedAt = run.waitConfig?.eventKind === 'message' ? Date.parse(run.waitConfig.parkedAt) : NaN;
        expect(parkedAt).toBeGreaterThanOrEqual(before - 1000);

        fromVariable.other.receiveMessage({ from: member, content: 'not here' });
        await recorded(member, 1);
        expect(await claimsFor(run)).toEqual([]);

        fromVariable.watched.receiveMessage({ from: member, content: 'here' });
        await completedThrough(run, 'after');
    });

    it('still times out by its Timed out exit when nobody says anything', async () => {
        const member = timed.guild.createMember({ username: 'silent_type' });
        const run = await parkedRun(timed.flowId, member);

        // An hour later, on the row only; then the scheduler's next tick, retried because a
        // tick still running from the startup sweep makes this one skip.
        await database
            .updateTable('flow_runs')
            .set({ wakeAt: new Date(Date.now() - 1000).toISOString() })
            .where('runId', '=', run.runId)
            .execute();
        await vi.waitFor(async () => {
            await runFlowRunTick(DISCORD_CLIENT);
            expect((await current(run)).status).toBe('completed');
        }, WAIT_FOR);

        const branches = (await current(run)).log.filter((entry) => entry.nodeId === 'wait').map((entry) => entry.branch);
        expect(branches).toContain(WAIT_TIMEOUT_HANDLE);
        expect((await current(run)).log.map((entry) => entry.nodeId)).toContain('late');
    });
});

describe('a reply after the deadline', () => {
    it('does not save a wait whose time limit passed before the message was sent', async () => {
        const member = timed.guild.createMember({ username: 'fashionably_too_late' });
        const run = await parkedRun(timed.flowId, member);

        // Past its limit, but not yet timed out — as while the scheduler holds message
        // waits through a restart's backfill.
        await database
            .updateTable('flow_runs')
            .set({ wakeAt: new Date(Date.now() - 1000).toISOString() })
            .where('runId', '=', run.runId)
            .execute();

        timed.lounge.receiveMessage({ from: member, content: 'sorry, here now' });
        await vi.waitFor(async () => expect(await claimsFor(run)).toEqual([null]), WAIT_FOR);
        expect((await current(run)).status).toBe('suspended');

        await vi.waitFor(async () => {
            await runFlowRunTick(DISCORD_CLIENT);
            expect((await current(run)).status).toBe('completed');
        }, WAIT_FOR);
        expect((await current(run)).log.map((entry) => entry.nodeId)).toContain('late');
    });
});

describe('the message-wait index', () => {
    it('wakes a run once for two messages sent back to back, and leaves it parked for the next', async () => {
        const member = looping.guild.createMember({ username: 'double_texter' });
        const run = await parkedRun(looping.flowId, member);

        // The second arrives while the first's wake is still in flight, when the run is
        // not waiting on anything — so it wakes nothing.
        looping.lounge.receiveMessage({ from: member, content: 'hello?' });
        looping.lounge.receiveMessage({ from: member, content: 'HELLO?' });
        await recorded(member, 2);
        await vi.waitFor(async () => {
            const row = await current(run);
            expect(row.status).toBe('suspended');
            expect(row.visitsUsed).toBe(4);
        }, WAIT_FOR);

        const won = (await claimsFor(run)).filter((claimed) => claimed !== null);
        expect(won).toHaveLength(1);
        expect(messageWaitIndex.get(run.runId)).toBeDefined();
    });

    it('finds the run again after each re-park, waking it once per message', async () => {
        const member = looping.guild.createMember({ username: 'chatterbox' });
        const run = await parkedRun(looping.flowId, member);
        expect(run.visitsUsed).toBe(2);

        looping.lounge.receiveMessage({ from: member, content: 'one' });
        await vi.waitFor(async () => {
            const row = await current(run);
            expect(row.status).toBe('suspended');
            expect(row.visitsUsed).toBe(4);
        }, WAIT_FOR);

        looping.lounge.receiveMessage({ from: member, content: 'two' });
        await vi.waitFor(async () => {
            const row = await current(run);
            expect(row.status).toBe('suspended');
            expect(row.visitsUsed).toBe(6);
        }, WAIT_FOR);
        await recorded(member, 2);

        // One claim per message: the run re-parked inside the first message's handler was
        // not handed back to it a second time.
        expect(await claimsFor(run)).toEqual([expect.objectContaining({ status: 'running' }), expect.objectContaining({ status: 'running' })]);
        expect((await current(run)).visitsUsed).toBe(6);
        expect(messageWaitIndex.get(run.runId)).toBeDefined();
    });

    it('cannot end a Delay through an entry left behind for a message wait', async () => {
        const member = delayed.guild.createMember({ username: 'patient_one' });
        const run = await parkedRun(delayed.flowId, member, 'delay');
        expect(messageWaitIndex.get(run.runId)).toBeUndefined();

        // An entry the index should not have: the run is on a Delay, not a message wait.
        messageWaitIndex.record({
            runId: run.runId,
            guildId: delayed.guild.id,
            userId: member.id,
            waitConfig: { eventKind: 'message', parkedAt: new Date().toISOString() },
            wakeAt: null,
        });

        delayed.lounge.receiveMessage({ from: member, content: 'are we there yet' });
        await recorded(member, 1);

        expect(await claimsFor(run)).toEqual([null]);
        const after = await current(run);
        expect(after.status).toBe('suspended');
        expect(after.resumeNodeId).toBe('delay');
        expect(after.wakeAt).toEqual(run.wakeAt);
    });

    it('wakes a run whose claim was given back after a fault, on the next message', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const member = released.guild.createMember({ username: 'second_try' });
        const run = await parkedRun(released.flowId, member);
        const release = vi.spyOn(flowRunsRepo, 'releaseClaim');
        vi.spyOn(flowsRepo, 'getByFlowId').mockRejectedValueOnce(new Error('database hiccup'));

        released.lounge.receiveMessage({ from: member, content: 'first' });
        await vi.waitFor(() => expect(release).toHaveBeenCalledWith(run.runId), WAIT_FOR);
        await release.mock.results[0]?.value;
        expect((await current(run)).status).toBe('suspended');

        released.lounge.receiveMessage({ from: member, content: 'second' });
        await completedThrough(run, 'after');
    });
});
