import { Hono } from 'hono';
import { beforeAll, describe, expect, it } from 'vitest';
import { ensureBlocksDiscovered } from '../../../features/flows/blocks/registry';
import { TRIGGER_SCHEDULE } from '../../../features/flows/blocks/triggerSchedule';
import { FLOW_GRAPH_VERSION, type FlowGraph } from '../../../features/flows/data/flowGraph';
import { flowsRepo } from '../../../features/flows/data/flowsRepo';
import { registerScheduleReconcile } from '../../../features/flows/logic/reconcileGuildSchedules';
import { migrateTestDatabase } from '../../../features-system/data-persistence/__tests__/support/migrateTestDatabase';
import type { AppEnv } from '../../types';
import type { FlowNextRunsBody } from '../flowBody';
import { flowRoutes } from '../flowRoutes';
import { guildRoutes } from '../guildRoutes';

/**
 * The countdown's route and the time-zone PUT that reschedules, through the real routes,
 * repos and an in-memory sqlite built by the real migrations — with reconcile wired after
 * every flow write exactly as `initFlows` wires it, so a save is followed by its schedules.
 *
 * Each case uses its own guild, so the shared database never couples two of them.
 */

let guildCount = 0;
function newGuildId(): string {
    guildCount += 1;
    return `guild-${guildCount}`;
}

function app(guildId: string) {
    const outer = new Hono<AppEnv>();
    outer.use('*', async (c, next) => {
        c.set('guild', { id: guildId, roles: { cache: new Map() }, channels: { cache: new Map() } } as never);
        c.set('user', { id: 'operator-1', username: 'operator', avatar: null, manageableGuildIds: [guildId] });
        await next();
    });
    outer.route('/', flowRoutes());
    outer.route('/', guildRoutes());
    return outer;
}

async function nextRuns(guildId: string, flowId: string): Promise<{ status: number; body: FlowNextRunsBody }> {
    const response = await app(guildId).request(`/${guildId}/flows/${flowId}/next-runs`);
    return { status: response.status, body: (await response.json()) as FlowNextRunsBody };
}

const DAILY_NINE: FlowGraph = {
    version: FLOW_GRAPH_VERSION,
    nodes: [{ id: 'nine', type: TRIGGER_SCHEDULE, position: { x: 0, y: 0 }, data: { repeat: 'daily', time: '09:00' } }],
    edges: [],
};

beforeAll(async () => {
    await ensureBlocksDiscovered();
    await migrateTestDatabase();
    registerScheduleReconcile(flowsRepo);
});

describe('GET /:guildId/flows/:flowId/next-runs', () => {
    it("lists each schedule's next time on a switched-on flow, with the zone it was worked out in", async () => {
        const guildId = newGuildId();
        const flow = await flowsRepo.create({ guildId, name: 'Morning roll call', graph: DAILY_NINE, enabled: true });

        const { status, body } = await nextRuns(guildId, flow.flowId);

        expect(status).toBe(200);
        expect(body.timeZone).toBe('America/Los_Angeles');
        expect(Object.keys(body.nextRuns)).toEqual(['nine']);
        expect(new Date(body.nextRuns.nine).getTime()).toBeGreaterThan(Date.now());
    });

    it('is empty for a switched-off flow', async () => {
        const guildId = newGuildId();
        const flow = await flowsRepo.create({ guildId, name: 'Morning roll call', graph: DAILY_NINE, enabled: true });
        await flowsRepo.update(flow.flowId, { enabled: false });

        expect((await nextRuns(guildId, flow.flowId)).body.nextRuns).toEqual({});
    });

    it("answers 404 for another guild's flow, as the other flow routes do", async () => {
        const owner = newGuildId();
        const flow = await flowsRepo.create({ guildId: owner, name: 'Not yours', graph: DAILY_NINE, enabled: true });

        const { status } = await nextRuns(newGuildId(), flow.flowId);

        expect(status).toBe(404);
    });
});

describe('PUT /:guildId/settings/time-zone', () => {
    it("reschedules the guild's schedules in the new zone", async () => {
        const guildId = newGuildId();
        const flow = await flowsRepo.create({ guildId, name: 'Morning roll call', graph: DAILY_NINE, enabled: true });
        const before = (await nextRuns(guildId, flow.flowId)).body;

        const response = await app(guildId).request(`/${guildId}/settings/time-zone`, {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ timeZone: 'Asia/Tokyo' }),
        });
        expect(response.status).toBe(200);

        const after = (await nextRuns(guildId, flow.flowId)).body;
        expect(after.timeZone).toBe('Asia/Tokyo');
        expect(after.nextRuns.nine).not.toBe(before.nextRuns.nine);
        // 09:00 in Tokyo is midnight UTC — Japan has no daylight time.
        expect(after.nextRuns.nine).toMatch(/T00:00:00\.000Z$/);
    });
});
