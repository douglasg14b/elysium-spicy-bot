import type { Guild } from 'discord.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FLOW_GRAPH_VERSION, type FlowGraph } from '../../data/flowGraph';

/**
 * Writing provisioned ids back into the flows that picked them.
 *
 * This is the half of "install writes snowflakes in" that shipped with no caller. The
 * behaviour worth pinning is what it *doesn't* do: it must not touch a flow that
 * picked real channels, must not enable anything, and must not quietly drop a
 * resource that failed to resolve — a node left without its id fails at run time far
 * from the cause, which is exactly the failure the whole design is avoiding.
 */

const resolveJourneyResources = vi.fn();
const getByGuildId = vi.fn();
const update = vi.fn();
const listLinksForGuild = vi.fn();
const getJourneyByKey = vi.fn();

vi.mock('../../../provisioning', () => ({
    resolveJourneyResources: (guild: unknown, key: string) => resolveJourneyResources(guild, key),
    flowJourneyLinksRepo: {
        listLinksForGuild: (guildId: string) => listLinksForGuild(guildId),
    },
    journeysRepo: {
        getByKey: (guildId: string, journeyKey: string) => getJourneyByKey(guildId, journeyKey),
    },
}));

vi.mock('../../data/flowsRepo', () => ({
    flowsRepo: {
        getByGuildId: (guildId: string) => getByGuildId(guildId),
        update: (flowId: string, patch: unknown) => update(flowId, patch),
    },
}));

const { applyResourcesToFlows } = await import('../applyResourcesToFlows');

// The sidecar scan asks each node's block which fields are pickers.
const { ensureBlocksDiscovered } = await import('../../blocks/registry');
await ensureBlocksDiscovered();

const GUILD_ID = 'guild-1';
// Only `.id` is ever read; a full Guild is unconstructible in a unit test.
const GUILD = { id: GUILD_ID } as unknown as Guild;

function flow(flowId: string, data: Record<string, unknown>) {
    const graph: FlowGraph = {
        version: FLOW_GRAPH_VERSION,
        // A block this build does not know, so every `*Key` here is read as a sidecar:
        // these tests are about writing ids, and several put a role and a channel on one
        // node, which no shipped block has. Which keys count is `resourceTargets.test.ts`.
        nodes: [{ id: 'node-1', type: 'fixture.notInThisBuild', position: { x: 0, y: 0 }, data }],
        edges: [],
    };
    return { flowId, guildId: GUILD_ID, name: flowId, enabled: false, graph };
}

beforeEach(() => {
    vi.clearAllMocks();
    resolveJourneyResources.mockResolvedValue({ live: new Map(), stale: [] });
    getByGuildId.mockResolvedValue([]);

    // The journey being installed exists; the scoping tests that need it gone say so.
    getJourneyByKey.mockImplementation(async (_guildId: string, journeyKey: string) => ({ journeyKey }));

    /*
     * Default: every flow the guild has is linked to `journey-1`, the journey the tests
     * above the scoping suite install. That keeps them about *writing ids*, which is what
     * they are for, while the scoping tests at the bottom set the links explicitly.
     *
     * Note these tests all passed before scoping existed, including the one asserting
     * several flows share a journey — the function ignored journeys entirely, so they
     * could not tell correct from broken. The suite at the bottom is the one that can.
     */
    listLinksForGuild.mockImplementation(async () => {
        const flows = (await getByGuildId(GUILD_ID)) as { flowId: string }[];
        return flows.map((eachFlow) => ({ flowId: eachFlow.flowId, journeyKey: 'journey-1' }));
    });
});

describe('applyResourcesToFlows', () => {
    it('writes a resolved id into the node that picked it', async () => {
        resolveJourneyResources.mockResolvedValue({
            live: new Map([['member-role', 'role-123']]),
            stale: [],
        });
        getByGuildId.mockResolvedValue([flow('flow-1', { roleId: '', roleIdKey: 'member-role' })]);

        const result = await applyResourcesToFlows(GUILD, 'journey-1');

        expect(result.writtenCount).toBe(1);
        expect(result.updatedFlowIds).toEqual(['flow-1']);

        const [, patch] = update.mock.calls[0] as [string, { graph: FlowGraph }];
        expect(patch.graph.nodes[0].data.roleId).toBe('role-123');
        // The key survives the write. It is canonical: keeping it is what makes a
        // deleted-and-recreated channel repairable by re-installing rather than by
        // editing every flow.
        expect(patch.graph.nodes[0].data.roleIdKey).toBe('member-role');
    });

    it('leaves a flow alone when it picked only real snowflakes', async () => {
        getByGuildId.mockResolvedValue([flow('flow-1', { roleId: '123456789012345678' })]);

        const result = await applyResourcesToFlows(GUILD, 'journey-1');

        expect(update).not.toHaveBeenCalled();
        expect(result.updatedFlowIds).toEqual([]);
    });

    it('does not write when nothing resolved', async () => {
        // Every target unresolved means there is no id to write. Saving the graph
        // anyway would bump updatedAt and suggest something happened.
        getByGuildId.mockResolvedValue([flow('flow-1', { roleId: '', roleIdKey: 'member-role' })]);

        const result = await applyResourcesToFlows(GUILD, 'journey-1');

        expect(update).not.toHaveBeenCalled();
        expect(result.writtenCount).toBe(0);
        expect(result.unresolved).toHaveLength(1);
    });

    it('distinguishes a stale binding from one that never existed', async () => {
        // Different fixes: stale means re-run install, unbound means the resource was
        // never installed at all. Collapsing them would send an operator the wrong way.
        resolveJourneyResources.mockResolvedValue({ live: new Map(), stale: ['deleted-channel'] });
        getByGuildId.mockResolvedValue([
            flow('flow-1', {
                channelId: '',
                channelIdKey: 'deleted-channel',
                roleId: '',
                roleIdKey: 'never-installed',
            }),
        ]);

        const result = await applyResourcesToFlows(GUILD, 'journey-1');

        const byKey = new Map(result.unresolved.map((entry) => [entry.resourceKey, entry.reason]));
        expect(byKey.get('deleted-channel')).toBe('stale');
        expect(byKey.get('never-installed')).toBe('unbound');
    });

    it('writes what resolved and reports what did not, in the same flow', async () => {
        // A partial install is a legitimate state. The half that landed should stop
        // waiting even though the other half has not.
        resolveJourneyResources.mockResolvedValue({
            live: new Map([['member-role', 'role-123']]),
            stale: [],
        });
        getByGuildId.mockResolvedValue([
            flow('flow-1', {
                roleId: '',
                roleIdKey: 'member-role',
                channelId: '',
                channelIdKey: 'qa-channel',
            }),
        ]);

        const result = await applyResourcesToFlows(GUILD, 'journey-1');

        expect(result.writtenCount).toBe(1);
        expect(result.unresolved.map((entry) => entry.resourceKey)).toEqual(['qa-channel']);

        const [, patch] = update.mock.calls[0] as [string, { graph: FlowGraph }];
        expect(patch.graph.nodes[0].data.roleId).toBe('role-123');
        expect(patch.graph.nodes[0].data.channelId).toBe('');
    });

    it('never changes a flow\'s enabled state or name', async () => {
        resolveJourneyResources.mockResolvedValue({
            live: new Map([['member-role', 'role-123']]),
            stale: [],
        });
        getByGuildId.mockResolvedValue([flow('flow-1', { roleId: '', roleIdKey: 'member-role' })]);

        await applyResourcesToFlows(GUILD, 'journey-1');

        const [, patch] = update.mock.calls[0] as [string, Record<string, unknown>];
        // Turning a flow on because it finally has its channels is the operator's
        // decision, not an install's.
        expect(Object.keys(patch)).toEqual(['graph']);
    });

    it('updates several flows sharing one journey', async () => {
        // The grouping case is deferred as an authoring surface, but the write-back
        // must already handle it: assuming one flow per journey would silently skip
        // the others the day grouping lands.
        resolveJourneyResources.mockResolvedValue({
            live: new Map([['shared-channel', 'chan-1']]),
            stale: [],
        });
        getByGuildId.mockResolvedValue([
            flow('flow-1', { channelId: '', channelIdKey: 'shared-channel' }),
            flow('flow-2', { channelId: '', channelIdKey: 'shared-channel' }),
        ]);

        const result = await applyResourcesToFlows(GUILD, 'journey-1');

        expect(result.updatedFlowIds).toEqual(['flow-1', 'flow-2']);
        expect(result.writtenCount).toBe(2);
    });
});

/**
 * The scoping that stops one journey writing into another's flows.
 *
 * A resource key is unique only within its journey, and this function matches on the
 * bare key — so the flow set it is handed *is* the correctness boundary. It ran over
 * every flow in the guild until 2026-09-22 while its own comment claimed otherwise, and
 * nothing above could detect it: every test used one journey, so "all flows" and "this
 * journey's flows" were the same set.
 */
describe('applyResourcesToFlows journey scoping', () => {
    it('does not write into a flow attached to a different journey', async () => {
        // Both journeys declare `welcome-channel` and mean different channels. That is
        // legal and is the entire point of a journey being a scope.
        resolveJourneyResources.mockResolvedValue({
            live: new Map([['welcome-channel', 'chan-onboarding']]),
            stale: [],
        });
        getByGuildId.mockResolvedValue([
            flow('flow-onboarding', { channelId: '', channelIdKey: 'welcome-channel' }),
            flow('flow-tickets', { channelId: '', channelIdKey: 'welcome-channel' }),
        ]);
        listLinksForGuild.mockResolvedValue([
            { flowId: 'flow-onboarding', journeyKey: 'onboarding' },
            { flowId: 'flow-tickets', journeyKey: 'tickets' },
        ]);

        const result = await applyResourcesToFlows(GUILD, 'onboarding');

        expect(result.updatedFlowIds).toEqual(['flow-onboarding']);
        expect(update).toHaveBeenCalledTimes(1);
        expect(update).not.toHaveBeenCalledWith('flow-tickets', expect.anything());
    });

    it('writes into every flow the journey does hold', async () => {
        resolveJourneyResources.mockResolvedValue({
            live: new Map([['shared-channel', 'chan-1']]),
            stale: [],
        });
        getByGuildId.mockResolvedValue([
            flow('flow-1', { channelId: '', channelIdKey: 'shared-channel' }),
            flow('flow-outsider', { channelId: '', channelIdKey: 'shared-channel' }),
            flow('flow-2', { channelId: '', channelIdKey: 'shared-channel' }),
        ]);
        listLinksForGuild.mockResolvedValue([
            { flowId: 'flow-1', journeyKey: 'onboarding' },
            { flowId: 'flow-2', journeyKey: 'onboarding' },
        ]);

        const result = await applyResourcesToFlows(GUILD, 'onboarding');

        expect(result.updatedFlowIds).toEqual(['flow-1', 'flow-2']);
    });

    it('writes nothing when the journey holds no flows', async () => {
        resolveJourneyResources.mockResolvedValue({
            live: new Map([['welcome-channel', 'chan-1']]),
            stale: [],
        });
        getByGuildId.mockResolvedValue([
            flow('flow-other', { channelId: '', channelIdKey: 'welcome-channel' }),
        ]);
        listLinksForGuild.mockResolvedValue([]);

        const result = await applyResourcesToFlows(GUILD, 'orphaned-journey');

        expect(result.updatedFlowIds).toEqual([]);
        expect(update).not.toHaveBeenCalled();
    });

    /** The pre-link case: no link row, journey keyed on the flow's own id. */
    it('still reaches a flow whose journey predates the link table', async () => {
        resolveJourneyResources.mockResolvedValue({
            live: new Map([['member-role', 'role-9']]),
            stale: [],
        });
        getByGuildId.mockResolvedValue([
            flow('flow-legacy', { roleId: '', roleIdKey: 'member-role' }),
        ]);
        listLinksForGuild.mockResolvedValue([]);

        const result = await applyResourcesToFlows(GUILD, 'flow-legacy');

        expect(result.updatedFlowIds).toEqual(['flow-legacy']);
    });

    /**
     * A flow grouped away keeps its id, and the journey keyed on that id keeps its row (a
     * merge empties it, a "leave" keeps it whole). Installing that old journey must not
     * write its ids into the flow: its sidecar keys now name the new journey's resources.
     */
    it('does not write into a flow grouped away from the journey keyed on its id', async () => {
        resolveJourneyResources.mockResolvedValue({
            live: new Map([['member-role', 'role-old']]),
            stale: [],
        });
        getByGuildId.mockResolvedValue([flow('flow-legacy', { roleId: '', roleIdKey: 'member-role' })]);
        listLinksForGuild.mockResolvedValue([{ flowId: 'flow-legacy', journeyKey: 'the-group' }]);

        const result = await applyResourcesToFlows(GUILD, 'flow-legacy');

        expect(result.updatedFlowIds).toEqual([]);
        expect(update).not.toHaveBeenCalled();
    });
});
