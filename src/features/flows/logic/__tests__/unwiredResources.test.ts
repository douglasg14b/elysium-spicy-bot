import type { Guild } from 'discord.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { JourneyDeclaration } from '../../../provisioning/logic/resourceDeclaration';
import type { FlowGraph } from '../../data/flowGraph';

const { resolveJourneyResources } = vi.hoisted(() => ({ resolveJourneyResources: vi.fn() }));
vi.mock('../../../provisioning', () => ({ resolveJourneyResources }));

const { ensureBlocksDiscovered } = await import('../../blocks/registry');
await ensureBlocksDiscovered();
const { unwiredResourceKeys } = await import('../unwiredResources');

const GUILD = { id: 'g1' } as Guild;

const JOURNEY = {
    journeyKey: 'j1',
    resources: [{ key: 'approval-process', kind: 'role', defaultName: 'Approval process' }],
} as unknown as JourneyDeclaration;

/** One Assign Role block that picked the declared role: its sidecar names it, its id is empty. */
function graphPicking(roleId: string): FlowGraph {
    return {
        nodes: [
            {
                id: 'n1',
                type: 'action.assignRole',
                position: { x: 0, y: 0 },
                data: { roleId, roleIdKey: 'approval-process' },
            },
        ],
        edges: [],
    } as unknown as FlowGraph;
}

beforeEach(() => resolveJourneyResources.mockReset());

describe('unwiredResourceKeys', () => {
    it('names a picked resource that is already bound, so install can fill its id in', async () => {
        resolveJourneyResources.mockResolvedValue({ live: new Map([['approval-process', '999']]), stale: [] });

        await expect(unwiredResourceKeys(GUILD, JOURNEY, graphPicking(''))).resolves.toEqual(['approval-process']);
    });

    it('leaves out one that is not bound: that is a plan item, not wiring', async () => {
        resolveJourneyResources.mockResolvedValue({ live: new Map(), stale: [] });

        await expect(unwiredResourceKeys(GUILD, JOURNEY, graphPicking(''))).resolves.toEqual([]);
    });

    it('is empty once the block holds the id, and does not ask Discord', async () => {
        await expect(unwiredResourceKeys(GUILD, JOURNEY, graphPicking('999'))).resolves.toEqual([]);
        expect(resolveJourneyResources).not.toHaveBeenCalled();
    });
});
