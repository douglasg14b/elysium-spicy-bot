import { Events, type GuildMember, type PartialGuildMember } from 'discord.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DISCORD_CLIENT } from '../../../discordClient';
import { TestDiscord, type ServerGuild, type ServerMember } from '../../../shared/__tests__/support/testDiscord';
import { ensureBlocksDiscovered } from '../blocks/registry';
import { ACTION_SEND_DM } from '../blocks/actionSendDM';
import { TRIGGER_MEMBER_JOIN } from '../blocks/triggerMemberJoin';
import { TRIGGER_MEMBER_LEAVE } from '../blocks/triggerMemberLeave';
import type { FlowRunSeed } from '../blocks/types';
import { FLOW_GRAPH_VERSION, type FlowGraph } from '../data/flowGraph';
import type { FlowEntity } from '../data/flowsSchema';

/**
 * Which runs a departure starts — driven through the bot's own `DISCORD_CLIENT`
 * against TestDiscord, so the client's real partials decide whether the event arrives.
 *
 * That is the case worth the harness: on a large server most leavers were never cached,
 * and discord.js drops GuildMemberRemove for those unless the client declares the
 * GuildMember partial. A hand-built member handed straight to the dispatcher could not
 * tell the difference.
 *
 * The listener is attached here rather than through `initFlows()`, which would also
 * start the durable-run scheduler and register every interaction handler.
 */

const getByGuildId = vi.fn();
const executeFlow = vi.fn();

vi.mock('../data/flowsRepo', () => ({
    flowsRepo: { getByGuildId: (...args: unknown[]) => getByGuildId(...args) },
}));

vi.mock('../engine/executor', () => ({
    executeFlow: (...args: unknown[]) => executeFlow(...args),
}));

const { handleMemberLeave } = await import('../engine/memberLeaveDispatch');

beforeAll(ensureBlocksDiscovered);

/** A flow whose given triggers each feed one DM. */
function flowWith(guildId: string, triggers: readonly { id: string; type: string }[], enabled = true): FlowEntity {
    const graph: FlowGraph = {
        version: FLOW_GRAPH_VERSION,
        nodes: [
            ...triggers.map((trigger, index) => ({ ...trigger, position: { x: 0, y: index * 120 }, data: {} })),
            { id: 'dm', type: ACTION_SEND_DM, position: { x: 200, y: 0 }, data: { message: 'Bye' } },
        ],
        edges: triggers.map((trigger) => ({ id: `e-${trigger.id}`, source: trigger.id, target: 'dm' })),
    };

    return {
        id: 1,
        flowId: `flow-${triggers.map((trigger) => trigger.id).join('-')}${enabled ? '' : '-off'}`,
        guildId,
        name: 'Departures',
        enabled,
        graph,
        entityVersion: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
    } as FlowEntity;
}

/*
 * One harness for the file: `DISCORD_CLIENT` is a singleton, and a discord.js client
 * cannot be handshaken again once destroyed. Each test brings its own member instead.
 */
const discord = new TestDiscord();
let guild: ServerGuild;
/** Every dispatch a departure caused, to await before asserting. */
let handled: Promise<void>[] = [];

/** A member who is in the guild, and in the client's cache, until the test removes them. */
function aMember(): ServerMember {
    return guild.createMember({ username: 'drifter' });
}

/** The seeds the dispatcher started runs with, in order. */
function seeds(): FlowRunSeed[] {
    return executeFlow.mock.calls.map((call) => call[3] as FlowRunSeed);
}

beforeAll(async () => {
    guild = discord.createGuild();
    const client = await discord.start({ client: DISCORD_CLIENT });
    client.on(Events.GuildMemberRemove, (left) => {
        handled.push(handleMemberLeave(left));
    });
});

afterAll(async () => {
    DISCORD_CLIENT.removeAllListeners(Events.GuildMemberRemove);
    await discord.destroy();
});

beforeEach(() => {
    vi.clearAllMocks();
    handled = [];
    executeFlow.mockResolvedValue({ status: 'success' });
});

describe('a member leaving', () => {
    it('starts a run for a member the bot never cached, about them and caused by nobody', async () => {
        const member = aMember();
        getByGuildId.mockResolvedValue([flowWith(guild.id, [{ id: 'left', type: TRIGGER_MEMBER_LEAVE }])]);
        // A large server's GUILD_CREATE carries only some members; this one is not among them.
        discord.clientGuild(guild).members.cache.delete(member.id);

        guild.removeMember(member);
        await Promise.all(handled);

        expect(executeFlow).toHaveBeenCalledTimes(1);
        const [seed] = seeds();
        expect(seed?.subject.id).toBe(member.id);
        expect((seed?.subject as GuildMember | PartialGuildMember).partial).toBe(true);
        expect(seed?.actor).toBeUndefined();
        expect(seed?.channel).toBeUndefined();
    });

    it('runs every memberLeave trigger in every enabled flow, and nothing else', async () => {
        const member = aMember();
        getByGuildId.mockResolvedValue([
            flowWith(guild.id, [
                { id: 'left-a', type: TRIGGER_MEMBER_LEAVE },
                { id: 'left-b', type: TRIGGER_MEMBER_LEAVE },
                { id: 'joined', type: TRIGGER_MEMBER_JOIN },
            ]),
            flowWith(guild.id, [{ id: 'left-off', type: TRIGGER_MEMBER_LEAVE }], false),
        ]);

        guild.removeMember(member);
        await Promise.all(handled);

        expect(executeFlow.mock.calls.map((call) => call[2])).toEqual(['left-a', 'left-b']);
    });

    it('runs the remaining triggers after one throws', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const member = aMember();
        getByGuildId.mockResolvedValue([
            flowWith(guild.id, [
                { id: 'left-a', type: TRIGGER_MEMBER_LEAVE },
                { id: 'left-b', type: TRIGGER_MEMBER_LEAVE },
            ]),
        ]);
        executeFlow.mockRejectedValueOnce(new Error('first one exploded'));

        guild.removeMember(member);
        await Promise.all(handled);

        expect(executeFlow).toHaveBeenCalledTimes(2);
    });
});
