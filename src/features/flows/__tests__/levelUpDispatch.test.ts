import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Guild, GuildMember } from 'discord.js';
import { ensureBlocksDiscovered } from '../blocks/registry';
import { FLOW_GRAPH_VERSION, type FlowGraph } from '../data/flowGraph';
import type { FlowEntity } from '../data/flowsSchema';
import { ACTION_ASSIGN_ROLE } from '../blocks/actionAssignRole';
import { TRIGGER_LEVEL_REACHED } from '../blocks/triggerLevelReached';
import { TRIGGER_MEMBER_JOIN } from '../blocks/triggerMemberJoin';

/**
 * Which flows — and which *triggers within* them — a level-up starts.
 *
 * Modelled on `memberJoinDispatch.test.ts` for the fan-out and isolation cases, which are
 * the same shape for every dispatcher. What is specific here is the **threshold match**:
 * this is the first trigger whose config is a number rather than a set of ids, and the
 * ways that goes wrong are its own — off-by-one on the boundary, a string `'10'` from the
 * form not matching a numeric `10`, and an unset level matching everything.
 */

const getByGuildId = vi.fn();
const executeFlow = vi.fn();
const fetchMember = vi.fn();

vi.mock('../data/flowsRepo', () => ({
    flowsRepo: { getByGuildId: (...args: unknown[]) => getByGuildId(...args) },
}));

vi.mock('../engine/executor', () => ({
    executeFlow: (...args: unknown[]) => executeFlow(...args),
}));

// Imported after the mocks so the dispatcher picks them up.
const { handleLevelUp } = await import('../engine/levelUpDispatch');

// The dispatcher asks the registry which trigger a level-up starts rather than comparing
// against an imported constant, so the blocks have to be discovered.
beforeAll(ensureBlocksDiscovered);

const GUILD_ID = 'guild-1';
const USER_ID = 'user-1';
const ROLE_ID = 'role-veteran';

/**
 * A flow whose levelReached triggers fire at each of `levels`.
 *
 * `data` holds whatever the caller passes, including a string, because that is what a
 * `text` control actually saves and the schema is what has to cope with it.
 */
function levelFlow(
    levels: readonly unknown[] = [10],
    overrides: Partial<FlowEntity> = {}
): FlowEntity {
    const triggers = levels.map((level, index) => ({
        id: index === 0 ? 'trigger' : `trigger-${index + 1}`,
        type: TRIGGER_LEVEL_REACHED,
        position: { x: 0, y: index * 120 },
        data: level === undefined ? {} : { level },
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
        flowId: 'flow-level',
        guildId: GUILD_ID,
        name: 'Veteran reward',
        enabled: true,
        graph,
        entityVersion: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
        ...overrides,
    } as FlowEntity;
}

function aGuild(): Guild {
    return {
        id: GUILD_ID,
        client: {},
        members: { fetch: (...args: unknown[]) => fetchMember(...args) },
    } as unknown as Guild;
}

function anEvent(level: number, totalXp = 5_000) {
    return { guild: aGuild(), userId: USER_ID, level, totalXp };
}

/** The trigger node ids the dispatcher started runs from, in order. */
function startedTriggers(): string[] {
    return executeFlow.mock.calls.map((call) => call[2] as string);
}

describe('handleLevelUp', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        executeFlow.mockResolvedValue({ status: 'success' });
        fetchMember.mockResolvedValue({ id: USER_ID, guild: aGuild() } as unknown as GuildMember);
    });

    it('runs a flow whose trigger names the level just reached', async () => {
        getByGuildId.mockResolvedValue([levelFlow([10])]);

        await handleLevelUp(anEvent(10));

        expect(executeFlow).toHaveBeenCalledWith('flow-level', expect.anything(), 'trigger', expect.anything());
    });

    it('does not run a trigger set to a different level', async () => {
        getByGuildId.mockResolvedValue([levelFlow([10])]);

        await handleLevelUp(anEvent(9));

        expect(executeFlow).not.toHaveBeenCalled();
    });

    it('fires on the exact level only, not every level past it', async () => {
        // The trigger is "reaches level 10", not "is at least level 10" — that is what
        // `condition.levelAtLeast` is for. A member climbing to 11 has already had their
        // level-10 run, and firing again would hand out the same reward twice.
        getByGuildId.mockResolvedValue([levelFlow([10])]);

        await handleLevelUp(anEvent(11));

        expect(executeFlow).not.toHaveBeenCalled();
    });

    it('matches a level the form saved as a string', async () => {
        // A `text` control stores `'10'`, not `10`. The trigger's schema coerces, and the
        // dispatcher compares the *parsed* value — comparing `node.data.level === level`
        // directly would silently never match anything an author typed.
        getByGuildId.mockResolvedValue([levelFlow(['10'])]);

        await handleLevelUp(anEvent(10));

        expect(executeFlow).toHaveBeenCalledTimes(1);
    });

    it('fires every matching trigger, not just the first', async () => {
        // Two rewards at the same level, authored as two triggers.
        getByGuildId.mockResolvedValue([levelFlow([10, 10])]);

        await handleLevelUp(anEvent(10));

        expect(startedTriggers()).toEqual(['trigger', 'trigger-2']);
    });

    it('fires only the triggers that match, among several levels', async () => {
        getByGuildId.mockResolvedValue([levelFlow([5, 10, 20])]);

        await handleLevelUp(anEvent(10));

        expect(startedTriggers()).toEqual(['trigger-2']);
    });

    it('ignores a trigger with no level set rather than firing on every level', async () => {
        // An author who dropped the block and has not filled it in yet should get
        // nothing, not a run on every level-up in the guild.
        getByGuildId.mockResolvedValue([levelFlow([undefined])]);

        await handleLevelUp(anEvent(10));

        expect(executeFlow).not.toHaveBeenCalled();
    });

    it('seeds the level and total xp as flow variables', async () => {
        getByGuildId.mockResolvedValue([levelFlow([10])]);

        await handleLevelUp(anEvent(10, 4_200));

        const seed = executeFlow.mock.calls[0]![3] as { variables: Record<string, unknown> };
        expect(seed.variables).toEqual({ level: 10, totalXp: 4_200 });
    });

    it('reports the member as both subject and actor', async () => {
        getByGuildId.mockResolvedValue([levelFlow([10])]);

        await handleLevelUp(anEvent(10));

        const seed = executeFlow.mock.calls[0]![3] as { subject: GuildMember; actor: GuildMember };
        expect(seed.subject.id).toBe(USER_ID);
        expect(seed.actor.id).toBe(USER_ID);
    });

    it('gives each trigger its own run seed', async () => {
        // Isolation asserted at this boundary rather than trusted to the executor's
        // re-bagging, which is a guarantee stated elsewhere and owned elsewhere.
        getByGuildId.mockResolvedValue([levelFlow([10, 10])]);
        executeFlow.mockImplementationOnce((...args: unknown[]) => {
            const seed = args[3] as { variables: Record<string, unknown> };
            seed.variables.leaked = 'from the first run';
            return Promise.resolve({ status: 'success' });
        });

        await handleLevelUp(anEvent(10));

        const secondSeed = executeFlow.mock.calls[1]![3] as { variables: Record<string, unknown> };
        expect(secondSeed.variables.leaked).toBeUndefined();
    });

    it('runs the remaining triggers after one throws', async () => {
        getByGuildId.mockResolvedValue([levelFlow([10, 10, 10])]);
        executeFlow.mockRejectedValueOnce(new Error('first one exploded'));

        await handleLevelUp(anEvent(10));

        expect(executeFlow).toHaveBeenCalledTimes(3);
    });

    it('keeps running other flows when one throws', async () => {
        getByGuildId.mockResolvedValue([
            levelFlow([10], { flowId: 'flow-first' }),
            levelFlow([10], { flowId: 'flow-second' }),
        ]);
        executeFlow.mockRejectedValueOnce(new Error('first flow exploded'));

        await handleLevelUp(anEvent(10));

        expect(executeFlow).toHaveBeenCalledTimes(2);
    });

    it('skips disabled flows', async () => {
        getByGuildId.mockResolvedValue([levelFlow([10], { enabled: false })]);

        await handleLevelUp(anEvent(10));

        expect(executeFlow).not.toHaveBeenCalled();
    });

    it('skips flows with no levelReached trigger', async () => {
        const flow = levelFlow([10]);
        const joinFlow: FlowEntity = {
            ...flow,
            graph: {
                ...flow.graph,
                nodes: [{ ...flow.graph.nodes[0]!, type: TRIGGER_MEMBER_JOIN, data: {} }, flow.graph.nodes[1]!],
            },
        };
        getByGuildId.mockResolvedValue([joinFlow]);

        await handleLevelUp(anEvent(10));

        expect(executeFlow).not.toHaveBeenCalled();
    });

    it('starts nothing when the member cannot be fetched', async () => {
        // XP is granted from gateway events for members who may have since left. Running
        // with no subject is not an option, and a rejected fetch must not crash the
        // subscriber either.
        getByGuildId.mockResolvedValue([levelFlow([10])]);
        fetchMember.mockRejectedValue(new Error('unknown member'));

        await expect(handleLevelUp(anEvent(10))).resolves.toBeUndefined();

        expect(executeFlow).not.toHaveBeenCalled();
    });

    it('does not read the flow table when the member is gone', async () => {
        // Cheap ordering check: the fetch comes first, so a departed member costs no query.
        fetchMember.mockRejectedValue(new Error('unknown member'));

        await handleLevelUp(anEvent(10));

        expect(getByGuildId).not.toHaveBeenCalled();
    });
});
