import type { Client, GuildMember, PartialGuildMember } from 'discord.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TicketChangeEvent, TicketChangeKind, TicketEntity } from '../../../tickets';
import {
    TestDiscord,
    type ServerChannel,
    type ServerGuild,
    type ServerMember,
} from '../../../../shared/__tests__/support/testDiscord';
import { ensureBlocksDiscovered } from '../../blocks/registry';
import { ACTION_SEND_MESSAGE } from '../../blocks/actionSendMessage';
import { TRIGGER_MEMBER_LEAVE } from '../../blocks/triggerMemberLeave';
import { TRIGGER_TICKET_EVENT } from '../../blocks/triggerTicketEvent';
import { FLOW_MAX_CHAIN_DEPTH } from '../../constants';
import { FLOW_GRAPH_VERSION, type FlowGraph } from '../../data/flowGraph';
import type { FlowEntity } from '../../data/flowsSchema';
import type { TriggeredRun } from '../../engine/triggeredRun';

/**
 * Which runs a ticket change starts, and what each is handed.
 *
 * Real discord.js against TestDiscord for the people and the channel, because the case
 * worth the harness is the member who has left: the dispatcher builds the same partial
 * member discord.js hands a Member Leaves run, and only a real `GuildMemberManager` can
 * show that it really is partial. The flows read and the run start are mocked — whether
 * a started run does the right thing is the executor's business, and the end-to-end file
 * beside the flows tests drives that.
 */

const getByGuildId = vi.fn();
const startTriggeredRun = vi.fn();

vi.mock('../../data/flowsRepo', () => ({
    flowsRepo: { getByGuildId: (...args: unknown[]) => getByGuildId(...args) },
}));

vi.mock('../../engine/triggeredRun', () => ({
    startTriggeredRun: (...args: unknown[]) => startTriggeredRun(...args),
}));

const { handleTicketChange, ticketChangeSubscriber } = await import('../ticketEventDispatch');

const discord = new TestDiscord();
let client: Client<true>;
let guild: ServerGuild;
let subject: ServerMember;
let moderator: ServerMember;
let ticketChannel: ServerChannel;

beforeAll(async () => {
    await ensureBlocksDiscovered();
    guild = discord.createGuild();
    subject = guild.createMember({ username: 'rope_bunny' });
    moderator = guild.createMember({ username: 'mistress_of_queues' });
    ticketChannel = guild.createTextChannel({ name: 'aftercare-0001' });
    client = await discord.start();
});

afterAll(async () => {
    await discord.destroy();
});

beforeEach(() => {
    vi.clearAllMocks();
    startTriggeredRun.mockResolvedValue(undefined);
});

function ticketRow(overrides: Partial<TicketEntity> = {}): TicketEntity {
    return {
        id: 12,
        guildId: guild.id,
        ticketNumber: 34,
        type: 'aftercare',
        status: 'open',
        subjectId: subject.id,
        openerId: moderator.id,
        claimerId: null,
        channelId: ticketChannel.id,
        subjectUsername: 'rope_bunny',
        subjectNickname: null,
        openerUsername: 'mistress_of_queues',
        openerNickname: null,
        claimerUsername: null,
        claimerNickname: null,
        stateMessageId: null,
        title: 'Checking in',
        reason: 'After a heavy scene.',
        openedAt: new Date('2026-10-03T00:00:00Z'),
        claimedAt: null,
        closedAt: null,
        deletedAt: null,
        updatedAt: new Date('2026-10-03T00:00:00Z'),
        ...overrides,
    } as TicketEntity;
}

function change(kind: TicketChangeKind, overrides: Partial<TicketChangeEvent> = {}): TicketChangeEvent {
    return {
        kind,
        ticket: ticketRow(),
        actorId: moderator.id,
        chainDepth: 0,
        changedAt: new Date('2026-10-03T12:00:00Z'),
        ...overrides,
    };
}

/** A flow whose triggers (each with its own config) feed one message. */
function flowWith(
    flowId: string,
    triggers: readonly { id: string; type?: string; data: Record<string, unknown> }[],
    enabled = true
): FlowEntity {
    const graph: FlowGraph = {
        version: FLOW_GRAPH_VERSION,
        nodes: [
            ...triggers.map((trigger, index) => ({
                id: trigger.id,
                type: trigger.type ?? TRIGGER_TICKET_EVENT,
                position: { x: 0, y: index * 120 },
                data: trigger.data,
            })),
            { id: 'say', type: ACTION_SEND_MESSAGE, position: { x: 200, y: 0 }, data: { message: 'hi' } },
        ],
        edges: triggers.map((trigger) => ({ id: `e-${trigger.id}`, source: trigger.id, target: 'say' })),
    };
    return { id: 1, flowId, guildId: guild.id, name: flowId, enabled, graph, entityVersion: 1 } as FlowEntity;
}

/** The runs the dispatcher started, in order. */
function started(): TriggeredRun[] {
    return startTriggeredRun.mock.calls.map((call) => call[0] as TriggeredRun);
}

describe('matching a ticket change to triggers', () => {
    it('starts every trigger on this event whose type is empty or this ticket’s, in enabled flows only', async () => {
        getByGuildId.mockResolvedValue([
            flowWith('flow-a', [
                { id: 'closed-any', data: { event: 'closed' } },
                { id: 'closed-aftercare', data: { event: 'closed', ticketType: 'aftercare' } },
                // A type the guild declared itself — nothing about the seeded two is special.
                { id: 'closed-other', data: { event: 'closed', ticketType: 'punishment-review' } },
                { id: 'opened-any', data: { event: 'opened' } },
                { id: 'left', type: TRIGGER_MEMBER_LEAVE, data: {} },
                // Matches nothing rather than everything.
                { id: 'broken', data: { event: 'exploded' } },
            ]),
            flowWith('flow-off', [{ id: 'closed-off', data: { event: 'closed' } }], false),
        ]);

        await handleTicketChange(client, change('closed'));

        expect(started().map((run) => [run.flowId, run.triggerNodeId, run.source])).toEqual([
            ['flow-a', 'closed-any', 'ticketChanged'],
            ['flow-a', 'closed-aftercare', 'ticketChanged'],
        ]);
    });

    it('reads a trigger with no event as Opened, its schema default', async () => {
        getByGuildId.mockResolvedValue([flowWith('flow-a', [{ id: 'fresh', data: {} }])]);

        await handleTicketChange(client, change('opened'));
        await handleTicketChange(client, change('closed'));

        expect(started().map((run) => run.triggerNodeId)).toEqual(['fresh']);
    });
});

describe('what a run started by a ticket change is handed', () => {
    it('the ticket’s member, whoever acted, the ticket channel, the change time and the ticket', async () => {
        getByGuildId.mockResolvedValue([flowWith('flow-a', [{ id: 'claimed', data: { event: 'claimed' } }])]);

        await handleTicketChange(client, change('claimed', { chainDepth: 0 }));

        const [run] = started();
        expect(run?.seed.subject?.id).toBe(subject.id);
        expect((run?.seed.subject as GuildMember | PartialGuildMember).partial).toBe(false);
        expect(run?.seed.actor?.id).toBe(moderator.id);
        expect(run?.seed.channel?.id).toBe(ticketChannel.id);
        expect(run?.seed.eventAt).toEqual(new Date('2026-10-03T12:00:00Z'));
        expect(run?.seed.variables).toEqual({ ticketId: 12, ticketChannelId: ticketChannel.id });
        // A person's change is depth 0, so the run it starts is the first link.
        expect(run?.seed.chainDepth).toBe(1);
    });

    it('the bot as the actor when a flow made the change, and the next depth down', async () => {
        getByGuildId.mockResolvedValue([flowWith('flow-a', [{ id: 'closed', data: { event: 'closed' } }])]);

        await handleTicketChange(client, change('closed', { actorId: client.user.id, chainDepth: 2 }));

        const [run] = started();
        expect(run?.seed.actor?.id).toBe(client.user.id);
        // Depth comes from the change, not from who made it.
        expect(run?.seed.chainDepth).toBe(3);
    });

    it('a partial actor, still named, when whoever made the change has left the server', async () => {
        // The actor is resolved as the subject is, so a Ticket Event run always has one —
        // which is what lets the trigger declare `actor`.
        const leaver = guild.createMember({ username: 'rage_quit_mod' });
        guild.removeMember(leaver);
        getByGuildId.mockResolvedValue([flowWith('flow-a', [{ id: 'closed', data: { event: 'closed' } }])]);

        await handleTicketChange(client, change('closed', { actorId: leaver.id }));

        const actor = started()[0]?.seed.actor;
        expect(actor?.id).toBe(leaver.id);
        expect(actor?.partial).toBe(true);
        expect(actor?.toString()).toBe(`<@${leaver.id}>`);
    });

    it('no channel and no channel variable for a deleted ticket', async () => {
        getByGuildId.mockResolvedValue([flowWith('flow-a', [{ id: 'deleted', data: { event: 'deleted' } }])]);

        await handleTicketChange(client, change('deleted', { ticket: ticketRow({ status: 'deleted', channelId: null }) }));

        const [run] = started();
        expect(run?.seed.channel).toBeUndefined();
        expect(run?.seed.variables).toEqual({ ticketId: 12 });
    });

    it('no channel and no channel variable when the ticket’s channel is gone, so the two agree', async () => {
        getByGuildId.mockResolvedValue([flowWith('flow-a', [{ id: 'closed', data: { event: 'closed' } }])]);

        // A channel id Discord does not hold: the fetch answers Unknown Channel.
        await handleTicketChange(client, change('closed', { ticket: ticketRow({ channelId: '999999999999999999' }) }));

        const [run] = started();
        expect(run?.seed.channel).toBeUndefined();
        expect(run?.seed.variables).toEqual({ ticketId: 12 });
    });

    it('a partial member, still named, when the ticket’s member has left the server', async () => {
        const leaver = guild.createMember({ username: 'flounced_off' });
        guild.removeMember(leaver);
        discord.flushGateway();
        getByGuildId.mockResolvedValue([flowWith('flow-a', [{ id: 'closed', data: { event: 'closed' } }])]);

        await handleTicketChange(client, change('closed', { ticket: ticketRow({ subjectId: leaver.id }) }));

        const [run] = started();
        const partial = run?.seed.subject as GuildMember | PartialGuildMember;
        expect(partial.id).toBe(leaver.id);
        // The object a Member Leaves run gets for an uncached leaver: no join date.
        expect(partial.partial).toBe(true);
        expect(partial.user.username).toBe('flounced_off');
        // Not cached as though they were still here.
        expect(discord.clientGuild(guild).members.cache.has(leaver.id)).toBe(false);
    });

    it('nothing at all when a member fetch fails for any reason but "not a member"', async () => {
        // A timeout or a rate limit says nothing about whether they left. Reading it as a
        // departure would hand a present member's run a partial with no roles.
        getByGuildId.mockResolvedValue([flowWith('flow-a', [{ id: 'closed', data: { event: 'closed' } }])]);
        // Everything a leaver's partial would need is here, so reading the hiccup as a
        // departure would visibly start a run rather than fail somewhere incidental.
        const userFetch = vi.fn().mockResolvedValue({ id: subject.id });
        const flaky = {
            id: guild.id,
            client: { users: { fetch: userFetch } },
            members: {
                fetch: vi.fn().mockRejectedValue(new Error('gateway hiccup')),
                _add: vi.fn().mockReturnValue({ id: subject.id, partial: true }),
            },
            channels: { fetch: vi.fn().mockResolvedValue(null) },
        };
        const flakyClient = { guilds: { cache: { get: () => flaky } } } as unknown as Client;

        const outcome = await handleTicketChange(flakyClient, change('closed')).then(
            () => 'started',
            (error: unknown) => (error instanceof Error ? error.message : String(error))
        );

        expect(startTriggeredRun).not.toHaveBeenCalled();
        expect(userFetch).not.toHaveBeenCalled();
        expect(outcome).toBe('gateway hiccup');
    });

    it('logs a failed dispatch from the subscriber, with nothing started', async () => {
        const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        getByGuildId.mockResolvedValue([flowWith('flow-a', [{ id: 'closed', data: { event: 'closed' } }])]);
        const flaky = { id: guild.id, members: { fetch: vi.fn().mockRejectedValue(new Error('gateway hiccup')) } };
        const flakyClient = { guilds: { cache: { get: () => flaky } } } as unknown as Client;

        ticketChangeSubscriber(flakyClient)(change('closed'));

        await vi.waitFor(() =>
            expect(logged).toHaveBeenCalledWith(expect.stringContaining('Error dispatching closed for ticket #34'), expect.any(Error))
        );
        expect(startTriggeredRun).not.toHaveBeenCalled();
    });
});

describe('a chain of flows setting each other off', () => {
    it(`starts a run at depth ${FLOW_MAX_CHAIN_DEPTH}, and refuses the next one down, naming the flow and the ticket`, async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        getByGuildId.mockResolvedValue([flowWith('flow-loop', [{ id: 'closed', data: { event: 'closed' } }])]);

        await handleTicketChange(client, change('closed', { actorId: moderator.id, chainDepth: FLOW_MAX_CHAIN_DEPTH - 1 }));
        expect(started().map((run) => run.seed.chainDepth)).toEqual([FLOW_MAX_CHAIN_DEPTH]);

        await handleTicketChange(client, change('closed', { actorId: moderator.id, chainDepth: FLOW_MAX_CHAIN_DEPTH }));

        expect(startTriggeredRun).toHaveBeenCalledTimes(1);
        expect(warn).toHaveBeenCalledWith(expect.stringMatching(/Refused to start flow flow-loop .*ticket #34/));
    });
});

describe('the subscriber flows registers with tickets', () => {
    it('does not start the run on the caller’s turn: it returns before any flow is read', async () => {
        getByGuildId.mockResolvedValue([flowWith('flow-b', [{ id: 'closed', data: { event: 'closed' } }])]);
        const subscriber = ticketChangeSubscriber(client);

        const returned = subscriber(change('closed'));
        // Microtasks drain, but the dispatch waits for a later turn.
        await Promise.resolve();
        await Promise.resolve();

        expect(returned).toBeUndefined();
        expect(getByGuildId).not.toHaveBeenCalled();
        await vi.waitFor(() => expect(startTriggeredRun).toHaveBeenCalledTimes(1));
    });

    it('never runs B nested in A’s step, nor on A’s turn', async () => {
        // Run A's Close Ticket hands the change to the subscriber mid-step, then A carries
        // on. B must not begin inside A's step, nor on A's turn. A's remaining work here
        // needs no I/O, so A ends first — which is not promised when A waits on Discord.
        getByGuildId.mockResolvedValue([flowWith('flow-b', [{ id: 'closed', data: { event: 'closed' } }])]);
        const order: string[] = [];
        startTriggeredRun.mockImplementation(async (run: TriggeredRun) => {
            order.push(`${run.flowId} starts`);
        });
        const subscriber = ticketChangeSubscriber(client);

        const runA = async (): Promise<void> => {
            order.push('A closes the ticket');
            await subscriber(change('closed', { actorId: moderator.id, chainDepth: 1 }));
            order.push('A sends its last message');
            await Promise.resolve();
            order.push('A ends');
        };
        await runA();

        await vi.waitFor(() => expect(order).toContain('flow-b starts'));
        expect(order).toEqual(['A closes the ticket', 'A sends its last message', 'A ends', 'flow-b starts']);
    });
});
