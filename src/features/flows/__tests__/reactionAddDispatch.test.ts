import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureBlocksDiscovered } from '../blocks/registry';
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

// The dispatcher asks the registry which trigger a reaction starts, rather than
// comparing against an imported type constant, so it needs the blocks discovered.
beforeAll(ensureBlocksDiscovered);

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
    /**
     * Make the channel something a guild run cannot post in — a DM.
     *
     * The narrowing is the only channel work this dispatcher does, so this is the
     * case that proves it still happens.
     */
    dmChannel?: boolean;
    guild?: unknown;
}

/**
 * A reaction shaped like the ones this dispatcher actually receives.
 *
 * `message.channel` is a **getter** over the client's channel cache, exactly as
 * discord.js declares it (`client.channels.resolve(this.channelId)`) — assigning
 * to it on a real `Message` throws, so a mock with a writable property would let a
 * fix that cannot possibly work look like one that does. That mistake has already
 * been made here once.
 *
 * The cache is always populated, because that is the only state in which this
 * handler runs: `MessageReactionAdd` resolves the channel through
 * `Action.getChannel`, which without `Partials.Channel` reads the cache and bails
 * out of the event entirely on a miss. Modelling an uncached channel would be
 * modelling a call that never happens.
 */
function aReaction(options: ReactionOptions = {}): MessageReaction | PartialMessageReaction {
    const guild =
        options.guild === undefined
            ? { id: GUILD_ID, members: { fetch: vi.fn().mockResolvedValue({ user: { id: 'user-1' } }) } }
            : options.guild;

    const channelId = options.channelId ?? CHANNEL_ID;
    const channel = {
        id: channelId,
        isDMBased: () => options.dmChannel ?? false,
        isTextBased: () => true,
    };

    const client = { channels: { resolve: (id: string) => (id === channelId ? channel : null) } };

    const message = {
        id: options.messageId ?? MESSAGE_ID,
        channelId,
        guild,
        partial: false,
        get channel() {
            return client.channels.resolve(channelId);
        },
    };

    return {
        partial: options.partial ?? false,
        fetch: vi.fn().mockResolvedValue(undefined),
        client,
        emoji: {
            id: options.emojiId ?? null,
            name: options.emojiName === undefined ? EMOJI : options.emojiName,
        },
        message,
    } as unknown as MessageReaction;
}

/** The run context the dispatcher handed `executeFlow`. */
function contextFromExecuteFlow(): { channel?: { id: string } } {
    return executeFlow.mock.calls[0]?.[3] as { channel?: { id: string } };
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

        await handleReactionAdd(aReaction(), USER);

        expect(executeFlow).toHaveBeenCalledTimes(1);
        expect(executeFlow).toHaveBeenCalledWith('flow-reaction', expect.anything(), 'trigger', expect.anything());
    });

    it('ignores a reaction on a different message', async () => {
        getByGuildId.mockResolvedValue([reactionFlow()]);

        await handleReactionAdd(aReaction({ messageId: 'some-other-message' }), USER);

        expect(executeFlow).not.toHaveBeenCalled();
    });

    it('ignores a reaction in a different channel', async () => {
        getByGuildId.mockResolvedValue([reactionFlow()]);

        await handleReactionAdd(aReaction({ channelId: 'some-other-channel' }), USER);

        expect(executeFlow).not.toHaveBeenCalled();
    });

    it('ignores a different emoji', async () => {
        getByGuildId.mockResolvedValue([reactionFlow()]);

        await handleReactionAdd(aReaction({ emojiName: '🍆' }), USER);

        expect(executeFlow).not.toHaveBeenCalled();
    });

    it('matches a custom emoji by its id', async () => {
        getByGuildId.mockResolvedValue([reactionFlow({ emoji: 'custom-emoji-id' })]);

        await handleReactionAdd(aReaction({ emojiId: 'custom-emoji-id', emojiName: 'spicy' }), USER);

        expect(executeFlow).toHaveBeenCalledTimes(1);
    });

    it('skips disabled flows', async () => {
        getByGuildId.mockResolvedValue([{ ...reactionFlow(), enabled: false }]);

        await handleReactionAdd(aReaction(), USER);

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

        await handleReactionAdd(aReaction(), USER);

        expect(executeFlow).not.toHaveBeenCalled();
    });

    it('ignores bot reactions without hitting the database', async () => {
        await handleReactionAdd(aReaction(), { id: 'bot-1', bot: true } as unknown as User);

        expect(getByGuildId).not.toHaveBeenCalled();
        expect(executeFlow).not.toHaveBeenCalled();
    });

    it('ignores reactions outside a guild', async () => {
        await handleReactionAdd(aReaction({ guild: null }), USER);

        expect(getByGuildId).not.toHaveBeenCalled();
        expect(executeFlow).not.toHaveBeenCalled();
    });

    it('fetches a partial reaction before matching', async () => {
        getByGuildId.mockResolvedValue([reactionFlow()]);
        const reaction = aReaction({ partial: true });

        await handleReactionAdd(reaction, USER);

        expect(reaction.fetch).toHaveBeenCalledTimes(1);
        expect(executeFlow).toHaveBeenCalledTimes(1);
    });

    it('supplies the channel its trigger declares', async () => {
        // `trigger.reactionAdd` declares `requires: ['channel']`, and save-time
        // validation treats a declaring trigger as a *supplier* — so a downstream
        // `condition.inChannel` reading no channel would answer "no" because
        // narrowing failed rather than because the run is elsewhere, which no
        // author could tell apart.
        getByGuildId.mockResolvedValue([reactionFlow()]);

        await handleReactionAdd(aReaction(), USER);

        expect(contextFromExecuteFlow().channel?.id).toBe(CHANNEL_ID);
    });

    it('runs a flow with no channel when the reaction is somewhere a run cannot use', async () => {
        // A DM is not somewhere a guild run can post, so the narrowing rejects it
        // and the run carries on knowing it is nowhere — a state the context
        // models deliberately. Dropping the flow instead would refuse work its
        // remaining steps (assigning a role here) never needed a channel for.
        getByGuildId.mockResolvedValue([reactionFlow()]);

        await handleReactionAdd(aReaction({ dmChannel: true }), USER);

        expect(executeFlow).toHaveBeenCalledTimes(1);
        expect(contextFromExecuteFlow().channel).toBeUndefined();
    });

    /*
     * ## Every matching trigger fires, not the first one authored
     *
     * The dispatcher used `.find()`, so a flow holding two triggers that both match
     * ran exactly one of them — chosen by position in `graph.nodes`, which is
     * *authoring order* and means nothing to an author. The other branch was silently
     * dead: no log, no validation warning, no way to tell from the canvas.
     *
     * It only bites when two triggers match the same event, so the common two-message
     * case hid it. The single-emoji case below is the one an author would actually
     * build — two reasons to react to the same message — and it ran half the flow.
     */
    it('fires every trigger that matches, not just the first', async () => {
        const base = reactionFlow();
        const twoTriggers: FlowEntity = {
            ...base,
            graph: {
                ...base.graph,
                nodes: [
                    base.graph.nodes[0]!,
                    {
                        ...base.graph.nodes[0]!,
                        id: 'trigger-2',
                        position: { x: 0, y: 120 },
                    },
                    base.graph.nodes[1]!,
                ],
            },
        };
        getByGuildId.mockResolvedValue([twoTriggers]);

        await handleReactionAdd(aReaction(), USER);

        expect(executeFlow).toHaveBeenCalledTimes(2);
        expect(executeFlow.mock.calls.map((call) => call[2])).toEqual(['trigger', 'trigger-2']);
    });

    it('still fires only the triggers that match', async () => {
        // The fan-out must not become "run every trigger on the flow": a second
        // trigger watching a different message is not this event.
        const base = reactionFlow();
        const mixed: FlowEntity = {
            ...base,
            graph: {
                ...base.graph,
                nodes: [
                    base.graph.nodes[0]!,
                    {
                        ...base.graph.nodes[0]!,
                        id: 'trigger-elsewhere',
                        position: { x: 0, y: 120 },
                        data: { channelId: CHANNEL_ID, messageId: 'another-message', emoji: EMOJI },
                    },
                    base.graph.nodes[1]!,
                ],
            },
        };
        getByGuildId.mockResolvedValue([mixed]);

        await handleReactionAdd(aReaction(), USER);

        expect(executeFlow).toHaveBeenCalledTimes(1);
        expect(executeFlow.mock.calls[0]![2]).toBe('trigger');
    });

    it('runs the remaining triggers after one of them throws', async () => {
        // Each trigger is its own run. `executeFlow` already isolates a flow from its
        // siblings for this reason, and two entry points into one graph deserve the
        // same treatment.
        const base = reactionFlow();
        const twoTriggers: FlowEntity = {
            ...base,
            graph: {
                ...base.graph,
                nodes: [
                    base.graph.nodes[0]!,
                    { ...base.graph.nodes[0]!, id: 'trigger-2', position: { x: 0, y: 120 } },
                    base.graph.nodes[1]!,
                ],
            },
        };
        getByGuildId.mockResolvedValue([twoTriggers]);
        executeFlow.mockRejectedValueOnce(new Error('first one exploded'));

        await handleReactionAdd(aReaction(), USER);

        expect(executeFlow).toHaveBeenCalledTimes(2);
    });

    it('does not let one trigger run leak variables into the next', async () => {
        /*
         * Each trigger gets its own seed.
         *
         * Sharing one across both runs would in fact survive the real executor, which
         * re-bags `variables` through `emptyBagWith` on the way in — but that is the
         * *executor's* guarantee, and two runs' isolation should not rest on a
         * property this dispatcher neither states nor owns. Asserted at this boundary
         * so the seeds stay separate whatever the executor later does.
         */
        const base = reactionFlow();
        const twoTriggers: FlowEntity = {
            ...base,
            graph: {
                ...base.graph,
                nodes: [
                    base.graph.nodes[0]!,
                    { ...base.graph.nodes[0]!, id: 'trigger-2', position: { x: 0, y: 120 } },
                    base.graph.nodes[1]!,
                ],
            },
        };
        getByGuildId.mockResolvedValue([twoTriggers]);

        // Whatever the first run does to the bag it was given must not be visible to
        // the second.
        executeFlow.mockImplementationOnce((...args: unknown[]) => {
            const seed = args[3] as { variables: Record<string, unknown> };
            seed.variables.leaked = 'from the first run';
            return Promise.resolve({ status: 'success' });
        });

        await handleReactionAdd(aReaction(), USER);

        expect(executeFlow).toHaveBeenCalledTimes(2);
        const secondSeed = executeFlow.mock.calls[1]![3] as { variables: Record<string, unknown> };
        expect(secondSeed.variables.leaked).toBeUndefined();
    });

    it('keeps dispatching to other flows when one member fetch fails', async () => {
        /*
         * The loop used `return` here, not `continue`.
         *
         * One member the bot cannot fetch — left the guild between reacting and the
         * event landing, or an API hiccup — abandoned dispatch for **every remaining
         * flow in the guild**, not just this one. The surrounding try/catch isolates
         * per flow deliberately; this one path stepped straight over it.
         */
        const failingGuild = {
            id: GUILD_ID,
            members: { fetch: vi.fn().mockRejectedValue(new Error('unknown member')) },
        };

        getByGuildId.mockResolvedValue([
            { ...reactionFlow(), flowId: 'flow-first' },
            { ...reactionFlow(), flowId: 'flow-second' },
        ]);

        await handleReactionAdd(aReaction({ guild: failingGuild }), USER);

        // Neither runs — the member could not be resolved for either — but the point
        // is that the second was *attempted*, which the fetch count proves.
        expect(failingGuild.members.fetch).toHaveBeenCalledTimes(2);
    });
});
