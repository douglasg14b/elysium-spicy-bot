import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppEnv } from '../../types';

/**
 * The "offer, never assume" decision, guarded.
 *
 * Deleting a flow removes the record and **nothing else**. It does not delete the
 * buttons it posted, and it does not delete the channels and roles its journey
 * created. Cleanup is a separate, separately confirmed action.
 *
 * The decision is easy to erode: somebody reasonably concludes that a deleted flow's
 * buttons are litter and wires the cleanup into the delete handler, and now a click
 * meant to remove a row silently destroys part of a live server. This test is what
 * makes that a failure rather than a helpful-looking commit.
 *
 * Sabotage-verified: calling `undeployFlowButtons` from the delete handler fails
 * *"deleting a flow > removes the row and nothing else"* below.
 */

const flowsRepoMock = {
    getByFlowId: vi.fn(),
    getByGuildId: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    deleteByFlowId: vi.fn(),
};

/** Every destructive path this handler could reach, all of them watched. */
const undeployMock = vi.fn();
const unpublishMock = vi.fn();
const previewUnpublishMock = vi.fn();
const buttonMessagesRepoMock = {
    listByFlowId: vi.fn(),
    persist: vi.fn(),
    forget: vi.fn(),
};

vi.mock('../../../features/flows/data/flowsRepo', () => ({ flowsRepo: flowsRepoMock }));
const journeysRepoMock = { getByKey: vi.fn() };
vi.mock('../../../features/provisioning/data/journeysRepo', () => ({
    journeysRepo: journeysRepoMock,
}));
vi.mock('../../../features/flows/data/flowButtonMessagesRepo', () => ({
    flowButtonMessagesRepo: buttonMessagesRepoMock,
    FlowButtonMessagesRepo: class {},
}));
vi.mock('../../../features/flows/logic/undeployFlowButtons', () => ({
    undeployFlowButtons: undeployMock,
}));
vi.mock('../../../features/provisioning', () => ({
    previewUnpublish: previewUnpublishMock,
    unpublishJourney: unpublishMock,
    plannedDeletions: () => [],
    plannedRefusals: () => [],
}));

const { flowRoutes } = await import('../flowRoutes');

const GUILD_ID = 'guild-1';
const FLOW_ID = 'flow-1';

function app() {
    const outer = new Hono<AppEnv>();
    outer.use('*', async (c, next) => {
        c.set('guild', { id: GUILD_ID } as never);
        await next();
    });
    outer.route('/', flowRoutes());
    return outer;
}

beforeEach(() => {
    vi.clearAllMocks();
    flowsRepoMock.getByFlowId.mockResolvedValue({
        flowId: FLOW_ID,
        guildId: GUILD_ID,
        name: 'A flow',
        enabled: true,
        graph: { version: 1, nodes: [], edges: [] },
        createdAt: new Date(),
        updatedAt: new Date(),
    });
});

describe('deleting a flow', () => {
    it('removes the row and nothing else', async () => {
        const response = await app().request(`/${GUILD_ID}/flows/${FLOW_ID}`, { method: 'DELETE' });

        expect(response.status).toBe(204);
        expect(flowsRepoMock.deleteByFlowId).toHaveBeenCalledWith(FLOW_ID);

        // The whole point. Nothing in the guild may be touched by a delete.
        expect(undeployMock).not.toHaveBeenCalled();
        expect(unpublishMock).not.toHaveBeenCalled();
        expect(buttonMessagesRepoMock.forget).not.toHaveBeenCalled();
    });

    it('leaves the record of where its buttons are posted intact', async () => {
        // Those rows are the only way to find the orphaned buttons afterwards. A delete
        // that tidied them away would make the buttons unretirable forever — strictly
        // worse than leaving them, because at least a row can still be acted on.
        await app().request(`/${GUILD_ID}/flows/${FLOW_ID}`, { method: 'DELETE' });

        expect(buttonMessagesRepoMock.forget).not.toHaveBeenCalled();
    });
});

describe('cleanup is reachable on its own', () => {
    it('undeploys only when asked directly', async () => {
        undeployMock.mockResolvedValue({ results: [] });

        const response = await app().request(`/${GUILD_ID}/flows/${FLOW_ID}/undeploy`, {
            method: 'POST',
        });

        expect(response.status).toBe(200);
        expect(undeployMock).toHaveBeenCalledWith(GUILD_ID, FLOW_ID);
    });

    it('undeploys a flow whose row is already gone', async () => {
        // The commonest cleanup: the flow was deleted, and its buttons are still live.
        // Requiring the flow to exist would make exactly that case unreachable.
        flowsRepoMock.getByFlowId.mockResolvedValue(null);
        undeployMock.mockResolvedValue({ results: [] });

        const response = await app().request(`/${GUILD_ID}/flows/${FLOW_ID}/undeploy`, {
            method: 'POST',
        });

        expect(response.status).toBe(200);
        expect(undeployMock).toHaveBeenCalled();
    });

    it('unpublishes only when asked directly', async () => {
        journeysRepoMock.getByKey.mockResolvedValue({
            journeyKey: FLOW_ID,
            guildId: GUILD_ID,
            createdForFlowId: FLOW_ID,
            resources: [],
        });
        previewUnpublishMock.mockResolvedValue({
            guildId: GUILD_ID,
            journeyKey: FLOW_ID,
            items: [],
        });
        unpublishMock.mockResolvedValue({ results: [] });

        const response = await app().request(`/${GUILD_ID}/flows/${FLOW_ID}/unpublish`, {
            method: 'POST',
        });

        expect(response.status).toBe(200);
        expect(unpublishMock).toHaveBeenCalled();
    });

    it('refuses to tear down a journey that belongs to a different flow', async () => {
        // Journey keys are operator-supplied, so one can collide with a flow id it has
        // nothing to do with. A URL shaped like a flow must not destroy someone else's
        // provisioning.
        journeysRepoMock.getByKey.mockResolvedValue({
            journeyKey: FLOW_ID,
            guildId: GUILD_ID,
            createdForFlowId: 'a-completely-different-flow',
            resources: [],
        });

        const response = await app().request(`/${GUILD_ID}/flows/${FLOW_ID}/unpublish`, {
            method: 'POST',
        });

        expect(response.status).toBe(409);
        expect(unpublishMock).not.toHaveBeenCalled();
    });

    it('refuses when the flow installed nothing at all', async () => {
        journeysRepoMock.getByKey.mockResolvedValue(null);

        const response = await app().request(`/${GUILD_ID}/flows/${FLOW_ID}/unpublish`, {
            method: 'POST',
        });

        expect(response.status).toBe(404);
        expect(unpublishMock).not.toHaveBeenCalled();
    });
});
