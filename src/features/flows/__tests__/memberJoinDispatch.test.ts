import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GuildMember } from 'discord.js';
import { ensureBlocksDiscovered } from '../blocks/registry';
import { FLOW_GRAPH_VERSION, type FlowGraph } from '../data/flowGraph';
import type { FlowEntity } from '../data/flowsSchema';
import { ACTION_ASSIGN_ROLE } from '../blocks/actionAssignRole';
import { TRIGGER_MEMBER_JOIN } from '../blocks/triggerMemberJoin';
import { TRIGGER_REACTION_ADD } from '../blocks/triggerReactionAdd';

/**
 * Which flows — and which *triggers within* them — a member join starts.
 *
 * This dispatcher had no suite at all, which is how it kept a defect that a single
 * two-trigger case would have caught: it used `.find()`, so a flow holding two
 * memberJoin triggers ran exactly one of them, picked by position in `graph.nodes`.
 * That is the order the author dropped blocks on the canvas, which means nothing, and
 * the second branch was silently dead — no log, no validation warning, two live-looking
 * triggers on screen.
 *
 * The matching rule here is far simpler than `reactionAdd`'s (no channel, message or
 * emoji to compare), so the cases worth having are the fan-out and the isolation.
 */

const getByGuildId = vi.fn();
const executeFlow = vi.fn();
const resumeWaitingRunsForEvent = vi.fn().mockResolvedValue(0);

vi.mock('../data/flowsRepo', () => ({
    flowsRepo: { getByGuildId: (...args: unknown[]) => getByGuildId(...args) },
}));

vi.mock('../engine/executor', () => ({
    executeFlow: (...args: unknown[]) => executeFlow(...args),
}));

// Waking parked durable runs has its own suite; stubbed so this stays a pure
// trigger-matching test with no database access.
vi.mock('../engine/waitingRunDispatch', () => ({
    resumeWaitingRunsForEvent: (...args: unknown[]) => resumeWaitingRunsForEvent(...args),
}));

// Imported after the mocks so the dispatcher picks them up.
const { handleMemberJoin } = await import('../engine/memberJoinDispatch');

// The dispatcher asks the registry which trigger a join starts rather than comparing
// against an imported constant, so the blocks have to be discovered.
beforeAll(ensureBlocksDiscovered);

const GUILD_ID = 'guild-1';
const ROLE_ID = 'role-newbie';

/** A flow with `triggerCount` memberJoin triggers feeding one action. */
function joinFlow(triggerCount = 1, overrides: Partial<FlowEntity> = {}): FlowEntity {
    const triggers = Array.from({ length: triggerCount }, (_unused, index) => ({
        id: index === 0 ? 'trigger' : `trigger-${index + 1}`,
        type: TRIGGER_MEMBER_JOIN,
        position: { x: 0, y: index * 120 },
        data: {},
    }));

    const graph: FlowGraph = {
        version: FLOW_GRAPH_VERSION,
        nodes: [
            ...triggers,
            { id: 'assign', type: ACTION_ASSIGN_ROLE, position: { x: 200, y: 0 }, data: { roleId: ROLE_ID } },
        ],
        edges: triggers.map((trigger, index) => ({
            id: `e${index}`,
            source: trigger.id,
            target: 'assign',
        })),
    };

    return {
        id: 1,
        flowId: 'flow-join',
        guildId: GUILD_ID,
        name: 'Welcome',
        enabled: true,
        graph,
        entityVersion: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
        ...overrides,
    } as FlowEntity;
}

function aMember(): GuildMember {
    return {
        id: 'user-1',
        client: {},
        guild: { id: GUILD_ID },
    } as unknown as GuildMember;
}

/** The trigger node ids the dispatcher started runs from, in order. */
function startedTriggers(): string[] {
    return executeFlow.mock.calls.map((call) => call[2] as string);
}

describe('handleMemberJoin', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        executeFlow.mockResolvedValue({ status: 'success' });
        resumeWaitingRunsForEvent.mockResolvedValue(0);
    });

    it('runs a flow with a memberJoin trigger', async () => {
        getByGuildId.mockResolvedValue([joinFlow()]);

        await handleMemberJoin(aMember());

        expect(executeFlow).toHaveBeenCalledTimes(1);
        expect(executeFlow).toHaveBeenCalledWith('flow-join', expect.anything(), 'trigger', expect.anything());
    });

    it('fires every memberJoin trigger, not just the first', async () => {
        // The defect. Two ways to welcome someone — a role and a DM, say — authored as
        // two triggers, and only whichever landed in the array first ever ran.
        getByGuildId.mockResolvedValue([joinFlow(2)]);

        await handleMemberJoin(aMember());

        expect(executeFlow).toHaveBeenCalledTimes(2);
        expect(startedTriggers()).toEqual(['trigger', 'trigger-2']);
    });

    it('runs the remaining triggers after one throws', async () => {
        getByGuildId.mockResolvedValue([joinFlow(3)]);
        executeFlow.mockRejectedValueOnce(new Error('first one exploded'));

        await handleMemberJoin(aMember());

        expect(executeFlow).toHaveBeenCalledTimes(3);
    });

    it('gives each trigger its own run seed', async () => {
        // Isolation asserted at this boundary rather than trusted to the executor's
        // re-bagging, which is a guarantee stated elsewhere and owned elsewhere.
        getByGuildId.mockResolvedValue([joinFlow(2)]);
        executeFlow.mockImplementationOnce((...args: unknown[]) => {
            const seed = args[3] as { variables: Record<string, unknown> };
            seed.variables.leaked = 'from the first run';
            return Promise.resolve({ status: 'success' });
        });

        await handleMemberJoin(aMember());

        const secondSeed = executeFlow.mock.calls[1]![3] as { variables: Record<string, unknown> };
        expect(secondSeed.variables.leaked).toBeUndefined();
    });

    it('keeps running other flows when one throws', async () => {
        getByGuildId.mockResolvedValue([
            joinFlow(1, { flowId: 'flow-first' }),
            joinFlow(1, { flowId: 'flow-second' }),
        ]);
        executeFlow.mockRejectedValueOnce(new Error('first flow exploded'));

        await handleMemberJoin(aMember());

        expect(executeFlow).toHaveBeenCalledTimes(2);
    });

    it('skips disabled flows', async () => {
        getByGuildId.mockResolvedValue([joinFlow(1, { enabled: false })]);

        await handleMemberJoin(aMember());

        expect(executeFlow).not.toHaveBeenCalled();
    });

    it('skips flows with no memberJoin trigger', async () => {
        const flow = joinFlow();
        const reactionFlow: FlowEntity = {
            ...flow,
            graph: {
                ...flow.graph,
                nodes: [
                    { ...flow.graph.nodes[0]!, type: TRIGGER_REACTION_ADD, data: {} },
                    flow.graph.nodes[1]!,
                ],
            },
        };
        getByGuildId.mockResolvedValue([reactionFlow]);

        await handleMemberJoin(aMember());

        expect(executeFlow).not.toHaveBeenCalled();
    });

    it('wakes parked runs before starting new ones', async () => {
        // A run already waiting on this member's join is answering an earlier
        // question; starting fresh runs first would let a new one race it.
        getByGuildId.mockResolvedValue([joinFlow()]);

        await handleMemberJoin(aMember());

        expect(resumeWaitingRunsForEvent).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ guildId: GUILD_ID, userId: 'user-1', eventKind: 'memberJoin' })
        );
        expect(resumeWaitingRunsForEvent.mock.invocationCallOrder[0]!).toBeLessThan(
            executeFlow.mock.invocationCallOrder[0]!
        );
    });
});
