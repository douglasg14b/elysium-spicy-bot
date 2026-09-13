import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FLOW_GRAPH_VERSION, type FlowGraph } from '../data/flowGraph';
import type { FlowEntity } from '../data/flowsSchema';
import { ACTION_ASSIGN_ROLE } from '../blocks/actionAssignRole';
import { TRIGGER_MEMBER_JOIN } from '../blocks/triggerMemberJoin';
import { TRIGGER_REACTION_ADD } from '../blocks/triggerReactionAdd';
import type { MessageReaction, PartialMessageReaction, User } from 'discord.js';

const getByGuildId = vi.fn();
const executeFlow = vi.fn();
const resumeWaitingRunsForEvent = vi.fn().mockResolvedValue(0);

vi.mock('../data/flowsRepo', () => ({
    flowsRepo: { getByGuildId: (...args: unknown[]) => getByGuildId(...args) },
}));

vi.mock('../engine/executor', () => ({
    executeFlow: (...args: unknown[]) => executeFlow(...args),
}));

// Waking parked durable runs is covered by its own suite; stub it out here so
// this suite stays a pure trigger-matching test with no database access.
vi.mock('../engine/waitingRunDispatch', () => ({
    resumeWaitingRunsForEvent: (...args: unknown[]) => resumeWaitingRunsForEvent(...args),
}));

// Imported after the mocks so the dispatcher picks them up.
const { handleReactionAdd } = await import('../engine/reactionAddDispatch');

const GUILD_ID = 'guild-1';
const CHANNEL_ID = 'channel-1';
const MESSAGE_ID = 'message-1';
const EMOJI = '🌶️';
const ROLE_ID = 'role-spicy';

function reactionFlow(overrides: Partial<Record<'channelId' | 'messageId' | 'emoji', string>> = {}): FlowEntity {
    const graph: FlowGraph = {
        version: FLOW_GRAPH_VERSION,
        nodes: [
            {
                id: 'trigger',
                type: TRIGGER_REACTION_ADD,
                position: { x: 0, y: 0 },
                data: {
                    channelId: overrides.channelId ?? CHANNEL_ID,
                    messageId: overrides.messageId ?? MESSAGE_ID,
                    emoji: overrides.emoji ?? EMOJI,
                },
            },
            { id: 'assign', type: ACTION_ASSIGN_ROLE, position: { x: 200, y: 0 }, data: { roleId: ROLE_ID } },
        ],
        edges: [{ id: 'e1', source: 'trigger', target: 'assign' }],
    };

    return {
        id: 1,
        flowId: 'flow-reaction',
        guildId: GUILD_ID,
        name: 'Spicy reaction role',
        enabled: true,
        graph,
        entityVersion: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
    } as FlowEntity;
}

interface ReactionOptions {
    channelId?: string;
    messageId?: string;
    emojiName?: string | null;
    emojiId?: string | null;
    partial?: boolean;
    guild?: unknown;
}

function makeReaction(options: ReactionOptions = {}): MessageReaction | PartialMessageReaction {
    const guild =
        options.guild === undefined
            ? { id: GUILD_ID, members: { fetch: vi.fn().mockResolvedValue({ user: { id: 'user-1' } }) } }
            : options.guild;

    return {
        partial: options.partial ?? false,
        fetch: vi.fn().mockResolvedValue(undefined),
        client: {},
        emoji: { id: options.emojiId ?? null, name: options.emojiName === undefined ? EMOJI : options.emojiName },
        message: {
            id: options.messageId ?? MESSAGE_ID,
            channelId: options.channelId ?? CHANNEL_ID,
            guild,
        },
    } as unknown as MessageReaction;
}

const USER = { id: 'user-1', bot: false } as unknown as User;

describe('handleReactionAdd', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        executeFlow.mockResolvedValue({ status: 'success' });
        resumeWaitingRunsForEvent.mockResolvedValue(0);
    });

    it('runs a flow whose trigger matches the channel, message and emoji', async () => {
        getByGuildId.mockResolvedValue([reactionFlow()]);

        await handleReactionAdd(makeReaction(), USER);

        expect(executeFlow).toHaveBeenCalledTimes(1);
        expect(executeFlow).toHaveBeenCalledWith('flow-reaction', expect.anything(), 'trigger', expect.anything());
    });

    it('ignores a reaction on a different message', async () => {
        getByGuildId.mockResolvedValue([reactionFlow()]);

        await handleReactionAdd(makeReaction({ messageId: 'some-other-message' }), USER);

        expect(executeFlow).not.toHaveBeenCalled();
    });

    it('ignores a reaction in a different channel', async () => {
        getByGuildId.mockResolvedValue([reactionFlow()]);

        await handleReactionAdd(makeReaction({ channelId: 'some-other-channel' }), USER);

        expect(executeFlow).not.toHaveBeenCalled();
    });

    it('ignores a different emoji', async () => {
        getByGuildId.mockResolvedValue([reactionFlow()]);

        await handleReactionAdd(makeReaction({ emojiName: '🍆' }), USER);

        expect(executeFlow).not.toHaveBeenCalled();
    });

    it('matches a custom emoji by its id', async () => {
        getByGuildId.mockResolvedValue([reactionFlow({ emoji: 'custom-emoji-id' })]);

        await handleReactionAdd(makeReaction({ emojiId: 'custom-emoji-id', emojiName: 'spicy' }), USER);

        expect(executeFlow).toHaveBeenCalledTimes(1);
    });

    it('skips disabled flows', async () => {
        getByGuildId.mockResolvedValue([{ ...reactionFlow(), enabled: false }]);

        await handleReactionAdd(makeReaction(), USER);

        expect(executeFlow).not.toHaveBeenCalled();
    });

    it('skips flows with no reactionAdd trigger', async () => {
        const flow = reactionFlow();
        const memberJoinFlow: FlowEntity = {
            ...flow,
            graph: {
                ...flow.graph,
                nodes: [{ ...flow.graph.nodes[0]!, type: TRIGGER_MEMBER_JOIN, data: {} }, flow.graph.nodes[1]!],
            },
        };
        getByGuildId.mockResolvedValue([memberJoinFlow]);

        await handleReactionAdd(makeReaction(), USER);

        expect(executeFlow).not.toHaveBeenCalled();
    });

    it('ignores bot reactions without hitting the database', async () => {
        await handleReactionAdd(makeReaction(), { id: 'bot-1', bot: true } as unknown as User);

        expect(getByGuildId).not.toHaveBeenCalled();
        expect(executeFlow).not.toHaveBeenCalled();
    });

    it('ignores reactions outside a guild', async () => {
        await handleReactionAdd(makeReaction({ guild: null }), USER);

        expect(getByGuildId).not.toHaveBeenCalled();
        expect(executeFlow).not.toHaveBeenCalled();
    });

    it('fetches a partial reaction before matching', async () => {
        getByGuildId.mockResolvedValue([reactionFlow()]);
        const reaction = makeReaction({ partial: true });

        await handleReactionAdd(reaction, USER);

        expect(reaction.fetch).toHaveBeenCalledTimes(1);
        expect(executeFlow).toHaveBeenCalledTimes(1);
    });
});
