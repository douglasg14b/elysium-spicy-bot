import { Events } from 'discord.js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { DISCORD_CLIENT } from '../../../discordClient';
import { activityEventsRepo, initActivityTracking } from '../../../features-system/activity';
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
import { ACTION_SEND_MESSAGE } from '../blocks/actionSendMessage';
import { ACTION_WAIT_FOR_EVENT } from '../blocks/actionWaitForEvent';
import { CONDITION_IN_CHANNEL } from '../blocks/conditionInChannel';
import { TRIGGER_LEVEL_REACHED } from '../blocks/triggerLevelReached';
import { TRIGGER_MEMBER_JOIN } from '../blocks/triggerMemberJoin';
import { TRIGGER_MEMBER_LEAVE } from '../blocks/triggerMemberLeave';
import { TRIGGER_MESSAGE_SENT } from '../blocks/triggerMessageSent';
import { FLOW_MESSAGE_LIMIT_PER_MEMBER } from '../constants';
import { FLOW_GRAPH_VERSION, type FlowEdge, type FlowGraph, type FlowNode } from '../data/flowGraph';
import { flowRunsRepo } from '../data/flowRunsRepo';
import type { FlowRunEntity } from '../data/flowRunsSchema';
import { flowsRepo } from '../data/flowsRepo';
import { handleLevelUp } from '../engine/levelUpDispatch';
import { messageActivityLimit } from '../engine/messageActivityLimit';
import { resetFlowRunSchedulerForTests } from '../engine/flowRunScheduler';
import { initFlows } from '../initFlows';

/**
 * Message Sent, live and end to end: the bot's own `DISCORD_CLIENT` against TestDiscord,
 * wired by the real `initActivityTracking()` and `initFlows()` in `bot.ts` order, on the
 * real migrated schema. Members post; the real recorder hands each message to the real
 * subscriber, which wakes waits and then starts triggers.
 *
 * Every run replies with Send Message into `{{var.postedInChannelId}}`, naming both of the
 * trigger's outputs — so where a reply lands proves the run's channel, and what it says
 * proves the outputs. One guild per concern, all built before the client starts:
 * TestDiscord can only create threads before `start()`.
 */

const WAIT_FOR = { timeout: 10_000 };

const discord = new TestDiscord();

type Place = ServerChannel | ServerThread;

function node(id: string, type: string, data: Record<string, unknown>): FlowNode {
    return { id, type, position: { x: 0, y: 0 }, data };
}

/** A reply posted where the message was, naming the trigger's two outputs. */
function replyNode(id: string, tag: string): FlowNode {
    return node(id, ACTION_SEND_MESSAGE, {
        channelId: '{{var.postedInChannelId}}',
        message: `${tag}|{{var.messageChannelId}}|{{var.postedInChannelId}}|{{subject.username}}`,
    });
}

function graph(nodes: FlowNode[], edges: FlowEdge[]): FlowGraph {
    return { version: FLOW_GRAPH_VERSION, nodes, edges };
}

/** Message Sent (with `triggerData`) → reply tagged `tag`. */
function replyingTo(triggerData: Record<string, unknown>, tag: string): FlowGraph {
    return graph(
        [node('trigger', TRIGGER_MESSAGE_SENT, triggerData), replyNode('reply', tag)],
        [{ id: 'e1', source: 'trigger', target: 'reply' }]
    );
}

async function enabledFlow(guild: ServerGuild, flowGraph: FlowGraph): Promise<string> {
    const flow = await flowsRepo.create({ guildId: guild.id, name: 'Mouthy', graph: flowGraph, enabled: true });
    return flow.flowId;
}

/** What the bot has posted in a place, oldest first. */
function botSaid(guild: ServerGuild, place: Place): string[] {
    return place.messages.filter((message) => message.authorId === guild.bot.id).map((message) => message.content);
}

/** Until the bot has posted `expected` in a place, as its newest message there. */
async function botReplies(guild: ServerGuild, place: Place, expected: string): Promise<void> {
    await vi.waitFor(() => expect(botSaid(guild, place).at(-1)).toBe(expected), WAIT_FOR);
}

/** Until activity has recorded `count` messages from this member, so the subscriber has been handed each. */
async function recorded(member: ServerMember, count: number): Promise<void> {
    await vi.waitFor(async () => {
        const rows = await database.selectFrom('activity_events').select('id').where('userId', '=', member.id).execute();
        expect(rows).toHaveLength(count);
    }, WAIT_FOR);
}

async function runsOf(flowId: string): Promise<FlowRunEntity[]> {
    const rows = await database.selectFrom('flow_runs').select('runId').where('flowId', '=', flowId).execute();
    const runs = await Promise.all(rows.map((row) => flowRunsRepo.getByRunId(row.runId)));
    return runs.filter((run): run is FlowRunEntity => run !== null);
}

/** A member who joins now — after start, so each is fresh for the flood limit. */
let memberCount = 0;
function newMember(guild: ServerGuild, username = `member_${(memberCount += 1)}`): { member: ServerMember; username: string } {
    return { member: guild.createMember({ username }), username };
}

let scopes: {
    guild: ServerGuild;
    dungeon: ServerChannel;
    cell: ServerChannel;
    cellThread: ServerThread;
    rules: ServerChannel;
    rulesThread: ServerThread;
    lounge: ServerChannel;
    loungeThread: ServerThread;
    elsewhere: ServerChannel;
};
let filtered: { guild: ServerGuild; den: ServerChannel; regular: ServerMember };
let parked: { guild: ServerGuild; flowId: string; confessional: ServerChannel; booth: ServerThread };
let writes: { guild: ServerGuild; flowId: string; first: ServerChannel; second: ServerChannel; third: ServerChannel; sentinel: ServerChannel };
let flaky: { guild: ServerGuild; flowId: string; den: ServerChannel; first: ServerMember; second: ServerMember };
let quiet: { guild: ServerGuild; den: ServerChannel; chatty: ServerMember };
let flood: { guild: ServerGuild; den: ServerChannel };
let loop: { guild: ServerGuild; flowId: string; den: ServerChannel };
let oneOffs: { guild: ServerGuild; hall: ServerChannel };

beforeAll(async () => {
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await migrateTestDatabase();

    // Where a message lands: a channel, a category, and a channel moved into one later.
    {
        const guild = discord.createGuild();
        const dungeon = guild.createCategory({ name: 'Dungeon' });
        const cell = guild.createTextChannel({ name: 'cell', parent: dungeon });
        const rules = guild.createTextChannel({ name: 'rules' });
        const lounge = guild.createTextChannel({ name: 'lounge' });
        scopes = {
            guild,
            dungeon,
            cell,
            cellThread: guild.createThread({ parent: cell, name: 'solitary' }),
            rules,
            rulesThread: guild.createThread({ parent: rules, name: 'rules-lawyering' }),
            lounge,
            loungeThread: guild.createThread({ parent: lounge, name: 'sofa' }),
            elsewhere: guild.createTextChannel({ name: 'elsewhere' }),
        };
        // The channel trigger asks In Channel about #rules before replying, so a reply in
        // the thread also proves a thread counts toward its channel there.
        await enabledFlow(
            guild,
            graph(
                [
                    node('trigger', TRIGGER_MESSAGE_SENT, { where: 'channel', channelId: rules.id }),
                    node('where', CONDITION_IN_CHANNEL, { channelId: rules.id }),
                    replyNode('reply', 'rules'),
                ],
                [
                    { id: 'e1', source: 'trigger', target: 'where' },
                    { id: 'e2', source: 'where', sourceHandle: 'true', target: 'reply' },
                ]
            )
        );
        await enabledFlow(guild, replyingTo({ where: 'category', categoryId: dungeon.id }, 'dungeon'));
    }

    // Anywhere, filtered on text.
    {
        const guild = discord.createGuild();
        filtered = { guild, den: guild.createTextChannel({ name: 'den' }), regular: guild.createMember({ username: 'regular' }) };
        await enabledFlow(guild, replyingTo({ where: 'anywhere', contains: '  ReAd ThE RuLeS ' }, 'heard'));
    }

    // Message Sent → wait for a message → reply → back to the wait, to read the parked run.
    {
        const guild = discord.createGuild();
        const confessional = guild.createTextChannel({ name: 'confessional' });
        const flowId = await enabledFlow(
            guild,
            graph(
                [node('trigger', TRIGGER_MESSAGE_SENT, { where: 'anywhere' }), node('wait', ACTION_WAIT_FOR_EVENT, { eventKind: 'message' }), replyNode('after', 'answered')],
                [
                    { id: 'e1', source: 'trigger', target: 'wait' },
                    { id: 'e2', source: 'wait', target: 'after' },
                    { id: 'e3', source: 'after', target: 'wait' },
                ]
            )
        );
        parked = { guild, flowId, confessional, booth: guild.createThread({ parent: confessional, name: 'booth' }) };
    }

    // Writes that change what fires.
    {
        const guild = discord.createGuild();
        const first = guild.createTextChannel({ name: 'first' });
        const sentinel = guild.createTextChannel({ name: 'sentinel' });
        writes = {
            guild,
            flowId: await enabledFlow(guild, replyingTo({ where: 'channel', channelId: first.id }, 'live')),
            first,
            second: guild.createTextChannel({ name: 'second' }),
            third: guild.createTextChannel({ name: 'third' }),
            sentinel,
        };
        // Always on, in its own channel: a reply here after a message that should start
        // nothing proves the earlier message was handled and started nothing.
        await enabledFlow(guild, replyingTo({ where: 'channel', channelId: sentinel.id }, 'sentinel'));
    }

    // A guild whose first load fails. Members joined before start, so no join reads its flows.
    {
        const guild = discord.createGuild();
        flaky = {
            guild,
            flowId: await enabledFlow(guild, replyingTo({ where: 'anywhere' }, 'retried')),
            den: guild.createTextChannel({ name: 'den' }),
            first: guild.createMember({ username: 'unlucky' }),
            second: guild.createMember({ username: 'lucky' }),
        };
    }

    // No trigger and no wait at all.
    {
        const guild = discord.createGuild();
        quiet = { guild, den: guild.createTextChannel({ name: 'den' }), chatty: guild.createMember({ username: 'chatty' }) };
    }

    // One member flooding a replying trigger.
    {
        const guild = discord.createGuild();
        flood = { guild, den: guild.createTextChannel({ name: 'den' }) };
        await enabledFlow(guild, replyingTo({ where: 'anywhere' }, 'flood'));
    }

    // Message Sent → reply → wait for a message → reply → back to the wait: without a
    // limit, every message wakes every earlier copy.
    {
        const guild = discord.createGuild();
        const flowId = await enabledFlow(
            guild,
            graph(
                [
                    node('trigger', TRIGGER_MESSAGE_SENT, { where: 'anywhere' }),
                    replyNode('hello', 'hello'),
                    node('wait', ACTION_WAIT_FOR_EVENT, { eventKind: 'message' }),
                    replyNode('again', 'again'),
                ],
                [
                    { id: 'e1', source: 'trigger', target: 'hello' },
                    { id: 'e2', source: 'hello', target: 'wait' },
                    { id: 'e3', source: 'wait', target: 'again' },
                    { id: 'e4', source: 'again', target: 'wait' },
                ]
            )
        );
        loop = { guild, flowId, den: guild.createTextChannel({ name: 'den' }) };
    }

    // The events that are never limited.
    {
        const guild = discord.createGuild();
        const hall = guild.createTextChannel({ name: 'hall' });
        oneOffs = { guild, hall };
        const announce = (trigger: FlowNode, said: string): FlowGraph =>
            graph(
                [trigger, node('say', ACTION_SEND_MESSAGE, { channelId: hall.id, message: `${said} {{subject.username}}` })],
                [{ id: 'e1', source: trigger.id, target: 'say' }]
            );
        await enabledFlow(guild, announce(node('joined', TRIGGER_MEMBER_JOIN, {}), 'joined'));
        await enabledFlow(guild, announce(node('left', TRIGGER_MEMBER_LEAVE, {}), 'left'));
        await enabledFlow(guild, announce(node('levelled', TRIGGER_LEVEL_REACHED, { level: 3 }), 'levelled'));
    }

    initActivityTracking();
    await initFlows();
    await discord.start({ client: DISCORD_CLIENT });
}, 60_000);

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

describe('where a message lands', () => {
    it('matches its channel, and a reply in a thread under it, which carries both outputs', async () => {
        const { guild, rules, rulesThread } = scopes;
        const { member, username } = newMember(guild);

        rules.receiveMessage({ from: member, content: 'obviously' });
        await botReplies(guild, rules, `rules|${rules.id}|${rules.id}|${username}`);

        // Posted in the thread: the run's channel is the thread, so the reply lands
        // there; "channel" is #rules and "posted in" the thread; and In Channel
        // answered Yes for #rules from the thread.
        rulesThread.receiveMessage({ from: member, content: 'well, actually' });
        await botReplies(guild, rulesThread, `rules|${rules.id}|${rulesThread.id}|${username}`);
    });

    it('matches every channel in a category, and the threads under them', async () => {
        const { guild, cell, cellThread } = scopes;
        const { member, username } = newMember(guild);

        cell.receiveMessage({ from: member, content: 'let me out' });
        await botReplies(guild, cell, `dungeon|${cell.id}|${cell.id}|${username}`);

        cellThread.receiveMessage({ from: member, content: 'still here' });
        await botReplies(guild, cellThread, `dungeon|${cell.id}|${cellThread.id}|${username}`);
    });

    it('matches a channel moved into the category from then on, threads included', async () => {
        const { guild, dungeon, rules, lounge, loungeThread, elsewhere } = scopes;
        const { member, username } = newMember(guild);

        lounge.receiveMessage({ from: member, content: 'not in the dungeon yet' });
        elsewhere.receiveMessage({ from: member, content: 'nobody listens here' });
        rules.receiveMessage({ from: member, content: 'sentinel' });
        await botReplies(guild, rules, `rules|${rules.id}|${rules.id}|${username}`);
        expect(botSaid(guild, lounge)).toEqual([]);
        expect(botSaid(guild, elsewhere)).toEqual([]);

        lounge.moveTo(dungeon);

        const { member: mover, username: moverName } = newMember(guild);
        lounge.receiveMessage({ from: mover, content: 'dragged in' });
        await botReplies(guild, lounge, `dungeon|${lounge.id}|${lounge.id}|${moverName}`);
        loungeThread.receiveMessage({ from: mover, content: 'and the sofa came too' });
        await botReplies(guild, loungeThread, `dungeon|${lounge.id}|${loungeThread.id}|${moverName}`);
    });
});

describe('what a message must say, and who must say it', () => {
    it('matches the text in any case, and never a miss, a bot, a webhook or a system message', async () => {
        const { guild, den, regular } = filtered;
        const { member, username } = newMember(guild);

        den.receiveMessage({ from: guild.bot, content: 'read the rules' });
        den.receiveMessage({ from: 'webhook', content: 'READ THE RULES' });
        den.receiveMessage({ from: regular, kind: 'joinNotice', content: 'read the rules' });
        den.receiveMessage({ from: regular, content: 'rules? never heard of them' });
        den.receiveMessage({ from: member, content: 'Go READ the rules, pet' });
        await vi.waitFor(() => expect(botSaid(guild, den).filter((said) => said.startsWith('heard'))).toHaveLength(1), WAIT_FOR);
        await recorded(regular, 1);

        // Settled: the regular's miss was handled before the hit that replied.
        expect(botSaid(guild, den).filter((said) => said.startsWith('heard'))).toEqual([`heard|${den.id}|${den.id}|${username}`]);
    });
});

describe('the run a message starts', () => {
    it('operates where the message was posted, and a wait it parks on listens only after that message', async () => {
        const { guild, flowId, booth } = parked;
        const { member, username } = newMember(guild);
        // Discord's clock five seconds ahead of the bot's: the message is "from the future".
        const sentAt = new Date(Date.now() + 5000);

        booth.receiveMessage({ from: member, content: 'forgive me', sentAt });

        /** The member's run, once parked on the wait having taken `visits` node visits. */
        const parkedRun = async (visits: number): Promise<FlowRunEntity> => {
            let run: FlowRunEntity | undefined;
            await vi.waitFor(async () => {
                run = (await runsOf(flowId)).find((candidate) => candidate.contextSnapshot.userId === member.id);
                expect(run?.status).toBe('suspended');
                expect(run?.visitsUsed).toBe(visits);
            }, WAIT_FOR);
            return run as FlowRunEntity;
        };
        const parkedAtOf = (run: FlowRunEntity): string | undefined =>
            run.waitConfig?.eventKind === 'message' ? run.waitConfig.parkedAt : undefined;

        const first = await parkedRun(2);
        expect(first.contextSnapshot.channelId).toBe(booth.id);
        // Started after the message that started it, not at the bot's own "now" before it.
        const parkedAt = parkedAtOf(first);
        expect(parkedAt).toBe(new Date(sentAt.getTime() + 1).toISOString());
        // So the catch-up after a restart cannot count the message as its own reply.
        expect(
            await activityEventsRepo.findLastMessageBetween({
                guildId: guild.id,
                userId: member.id,
                from: new Date(parkedAt as string),
                to: new Date(sentAt.getTime() + 60_000),
            })
        ).toBeNull();

        // The same holds for the message that wakes it: parked again, it listens after that one.
        const wokenBy = new Date(sentAt.getTime() + 2000);
        booth.receiveMessage({ from: member, content: 'and another thing', sentAt: wokenBy });
        await botReplies(guild, booth, `answered|${parked.confessional.id}|${booth.id}|${username}`);
        expect(parkedAtOf(await parkedRun(4))).toBe(new Date(wokenBy.getTime() + 1).toISOString());
    });
});

describe('what fires changes without a restart', () => {
    /** Post in `place` and the sentinel, then report what the bot said in `place`. */
    async function nothingStartsIn(place: ServerChannel): Promise<void> {
        const { guild, sentinel } = writes;
        const { member, username } = newMember(guild);
        place.receiveMessage({ from: member, content: 'anyone?' });
        sentinel.receiveMessage({ from: member, content: 'sentinel' });
        await botReplies(guild, sentinel, `sentinel|${sentinel.id}|${sentinel.id}|${username}`);
        expect(botSaid(guild, place).at(-1) ?? '').not.toContain(username);
    }

    async function startsIn(place: ServerChannel): Promise<void> {
        const { guild } = writes;
        const { member, username } = newMember(guild);
        place.receiveMessage({ from: member, content: 'hello?' });
        await botReplies(guild, place, `live|${place.id}|${place.id}|${username}`);
    }

    const scopedTo = (channel: ServerChannel): FlowGraph => replyingTo({ where: 'channel', channelId: channel.id }, 'live');

    it('follows a save, a switch off and on, an install writing ids back, and a delete', async () => {
        const { flowId, first, second, third } = writes;
        await startsIn(first);

        // A save from the builder.
        await flowsRepo.mutate(flowId, () => ({ kind: 'write', input: { graph: scopedTo(second) } }));
        await nothingStartsIn(first);
        await startsIn(second);

        // Switched off, then on, from the list.
        await flowsRepo.mutate(flowId, () => ({ kind: 'write', input: { enabled: false } }));
        await nothingStartsIn(second);
        await flowsRepo.mutate(flowId, () => ({ kind: 'write', input: { enabled: true } }));
        await startsIn(second);

        // An install writing the channel it created back into the flow.
        await flowsRepo.update(flowId, { graph: scopedTo(third) });
        await nothingStartsIn(second);
        await startsIn(third);

        await flowsRepo.deleteByFlowId(flowId);
        await nothingStartsIn(third);
    });
});

describe('loading a guild', () => {
    it('leaves a guild whose load failed alone — no read, no log — until a flow is saved', async () => {
        const { guild, flowId, den, first, second } = flaky;
        const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const reads = vi.spyOn(flowsRepo, 'getByGuildId').mockRejectedValueOnce(new Error('one unreadable graph'));
        const failures = () => error.mock.calls.filter(([line]) => String(line).includes('Could not load the Message Sent triggers'));
        const guildReads = () => reads.mock.calls.filter(([guildId]) => guildId === guild.id);

        den.receiveMessage({ from: first, content: 'is this thing on' });
        await recorded(first, 1);
        await vi.waitFor(() => expect(failures()).toHaveLength(1), WAIT_FOR);

        // Inside the window the failure opened: handled, but nothing read, logged or started.
        den.receiveMessage({ from: second, content: 'hello? anyone?' });
        await recorded(second, 1);
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(guildReads()).toHaveLength(1);
        expect(failures()).toHaveLength(1);
        expect(botSaid(guild, den)).toEqual([]);

        // A save ends the window at once: the next message reads the flows and starts the run.
        await flowsRepo.mutate(flowId, () => ({ kind: 'write', input: { enabled: true } }));
        den.receiveMessage({ from: first, content: 'try me' });
        await botReplies(guild, den, `retried|${den.id}|${den.id}|unlucky`);
        expect(botSaid(guild, den)).toHaveLength(1);
        expect(guildReads()).toHaveLength(2);
        reads.mockRestore();
        error.mockRestore();
    });

    it('reads nothing per message in a guild with no trigger and no wait', async () => {
        const { guild, den, chatty } = quiet;
        const guildReads = vi.spyOn(flowsRepo, 'getByGuildId');
        const flowReads = vi.spyOn(flowsRepo, 'getByFlowId');
        const claims = vi.spyOn(flowRunsRepo, 'claimForResume');

        den.receiveMessage({ from: chatty, content: 'first' });
        await recorded(chatty, 1);
        // The guild's one load, on its first message.
        await vi.waitFor(() => expect(guildReads.mock.calls.filter(([guildId]) => guildId === guild.id)).toHaveLength(1), WAIT_FOR);

        for (const content of ['second', 'third', 'fourth', 'fifth']) {
            den.receiveMessage({ from: chatty, content });
        }
        await recorded(chatty, 5);
        await new Promise((resolve) => setTimeout(resolve, 100));

        expect(guildReads.mock.calls.filter(([guildId]) => guildId === guild.id)).toHaveLength(1);
        expect(flowReads).not.toHaveBeenCalled();
        expect(claims).not.toHaveBeenCalled();
        guildReads.mockRestore();
        flowReads.mockRestore();
        claims.mockRestore();
    });
});

describe('the flood limit', () => {
    it("starts at most a member's burst when they flood, while someone else still gets through", async () => {
        const { guild, den } = flood;
        const { member: flooder, username: flooderName } = newMember(guild, 'spam_goblin');
        const { member: bystander, username: bystanderName } = newMember(guild, 'innocent');

        for (let line = 0; line < 12; line += 1) {
            den.receiveMessage({ from: flooder, content: `spam ${line}` });
        }
        den.receiveMessage({ from: bystander, content: 'just saying hi' });
        await recorded(flooder, 12);

        await vi.waitFor(() => expect(botSaid(guild, den).some((said) => said.endsWith(`|${bystanderName}`))).toBe(true), WAIT_FOR);
        await vi.waitFor(
            () => expect(botSaid(guild, den).filter((said) => said.endsWith(`|${flooderName}`)).length).toBeGreaterThanOrEqual(FLOW_MESSAGE_LIMIT_PER_MEMBER),
            WAIT_FOR
        );
        await new Promise((resolve) => setTimeout(resolve, 300));

        // One more at most, should a token have come back while the test ran.
        expect(botSaid(guild, den).filter((said) => said.endsWith(`|${flooderName}`)).length).toBeLessThanOrEqual(
            FLOW_MESSAGE_LIMIT_PER_MEMBER + 1
        );
    });

    it('keeps "reply, then wait for a message, then reply" bounded under a burst, and logs one line', async () => {
        const { guild, flowId, den } = loop;
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const { member } = newMember(guild, 'motormouth');

        // Each message once the runs before it have had time to park, so every one of
        // them is there to be woken.
        for (let line = 0; line < 10; line += 1) {
            den.receiveMessage({ from: member, content: `line ${line}` });
            await recorded(member, line + 1);
            await new Promise((resolve) => setTimeout(resolve, 150));
        }

        // Until the bot stops talking.
        let previous = -1;
        await vi.waitFor(async () => {
            const count = botSaid(guild, den).length;
            const settled = count === previous;
            previous = count;
            await new Promise((resolve) => setTimeout(resolve, 200));
            expect(settled).toBe(true);
        }, WAIT_FOR);

        // Unlimited, the tenth message wakes nine parked runs and starts a tenth: fifty-five
        // replies in all. Limited, starts and wake-ups together spend the member's burst —
        // and one more at most, should a token come back meanwhile.
        expect(botSaid(guild, den).length).toBeGreaterThanOrEqual(1);
        expect(botSaid(guild, den).length).toBeLessThanOrEqual(FLOW_MESSAGE_LIMIT_PER_MEMBER + 1);

        // A skipped wake-up is not lost: every run is still parked, for the next message.
        const runs = await runsOf(flowId);
        expect(runs.length).toBeGreaterThanOrEqual(1);
        expect(runs.every((run) => run.status === 'suspended' && run.resumeNodeId === 'wait')).toBe(true);

        messageActivityLimit.flushSummary();
        const lines = warn.mock.calls.map(([line]) => String(line)).filter((line) => line.includes(`in guild ${guild.id}`));
        expect(lines).toEqual([expect.stringMatching(/^\[flows\] Message limit: skipped \d+ run start\(s\) and \d+ wake-up\(s\)/)]);
        warn.mockRestore();
    });

    it('never limits a join, a leave or a level-up', async () => {
        const { guild, hall } = oneOffs;
        const take = vi.spyOn(messageActivityLimit, 'take').mockReturnValue(false);

        const { member, username } = newMember(guild, 'newcomer');
        await botReplies(guild, hall, `joined ${username}`);

        await handleLevelUp({ guild: discord.clientGuild(guild), userId: member.id, level: 3, totalXp: 900 });
        await botReplies(guild, hall, `levelled ${username}`);

        guild.removeMember(member);
        await botReplies(guild, hall, `left ${username}`);

        expect(take).not.toHaveBeenCalled();
        take.mockRestore();
    });
});
