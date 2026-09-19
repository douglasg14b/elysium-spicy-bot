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

vi.mock('../../../provisioning', () => ({
    resolveJourneyResources: (guild: unknown, key: string) => resolveJourneyResources(guild, key),
}));

vi.mock('../../data/flowsRepo', () => ({
    flowsRepo: {
        getByGuildId: (guildId: string) => getByGuildId(guildId),
        update: (flowId: string, patch: unknown) => update(flowId, patch),
    },
}));

const { applyResourcesToFlows } = await import('../applyResourcesToFlows');

const GUILD_ID = 'guild-1';
// Only `.id` is ever read; a full Guild is unconstructible in a unit test.
const GUILD = { id: GUILD_ID } as unknown as Guild;

function flow(flowId: string, data: Record<string, unknown>) {
    const graph: FlowGraph = {
        version: FLOW_GRAPH_VERSION,
        nodes: [{ id: 'node-1', type: 'action.assignRole', position: { x: 0, y: 0 }, data }],
        edges: [],
    };
    return { flowId, guildId: GUILD_ID, name: flowId, enabled: false, graph };
}

beforeEach(() => {
    vi.clearAllMocks();
    resolveJourneyResources.mockResolvedValue({ live: new Map(), stale: [] });
    getByGuildId.mockResolvedValue([]);
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
