import { Hono } from 'hono';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { FLOW_GRAPH_VERSION } from '../../../features/flows/data/flowGraph';
import { flowsRepo } from '../../../features/flows/data/flowsRepo';
import { flowJourneyLinksRepo } from '../../../features/provisioning/data/flowJourneyLinksRepo';
import { journeysRepo } from '../../../features/provisioning/data/journeysRepo';
import type { ResourceDeclaration } from '../../../features/provisioning/logic/resourceDeclaration';
import { migrateTestDatabase } from '../../../features-system/data-persistence/__tests__/support/migrateTestDatabase';
import type { AppEnv } from '../../types';
import { GROUP_CHANGED_MESSAGE, journeyVersion, STALE_RESOURCES_MESSAGE } from '../journeyBody';
import { journeyRoutes } from '../journeyRoutes';

/**
 * The version check on both resource saves, through the real routes and repos over an
 * in-memory SQLite built by the real migrations.
 *
 * Both saves replace the whole list, so a list edited from a version of the journey that has
 * moved on would delete what moved it. Each save sends the version its list was read at
 * (`baseUpdatedAt`) and is written only while the journey is still at it; the answer carries
 * the new one. A save sending none, to a journey that exists, is a tab from before the guard
 * — the one it is for — and refused the same way. The flow's first save has none to send.
 */

interface Reply<T> {
    readonly status: number;
    readonly body: T;
}

interface StoredBody {
    resources: ResourceDeclaration[];
    updatedAt: string | null;
}

interface JourneyBody {
    resources: ResourceDeclaration[];
    name: string;
    updatedAt: string;
}

const LOBBY: ResourceDeclaration = { key: 'lobby', kind: 'textChannel', defaultName: 'lobby' };
const DUNGEON: ResourceDeclaration = { key: 'dungeon', kind: 'textChannel', defaultName: 'dungeon' };
const AFTERCARE: ResourceDeclaration = { key: 'aftercare', kind: 'textChannel', defaultName: 'aftercare' };

let guildCount = 0;

function freshGuild(): string {
    guildCount += 1;
    return `version-guild-${guildCount}`;
}

function app(guildId: string): Hono<AppEnv> {
    const outer = new Hono<AppEnv>();
    outer.use('*', async (c, next) => {
        c.set('guild', { id: guildId } as never);
        await next();
    });
    outer.route('/', journeyRoutes());
    outer.onError((_error, c) => c.json({ error: 'Internal error.' }, 500));
    return outer;
}

async function send<T>(guildId: string, method: string, path: string, body?: unknown): Promise<Reply<T>> {
    const response = await app(guildId).request(`/${guildId}${path}`, {
        method,
        headers: { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: (await response.json()) as T };
}

async function newFlow(guildId: string): Promise<string> {
    const flow = await flowsRepo.create({
        guildId,
        name: 'Doorman',
        graph: { version: FLOW_GRAPH_VERSION, nodes: [], edges: [] },
        enabled: false,
    });
    return flow.flowId;
}

// Every migration: past the default hook timeout under a full parallel run.
beforeAll(async () => {
    await migrateTestDatabase();
}, 30_000);

describe('PUT /flows/{flowId}/resources', () => {
    it('creates the journey on the first save, which sends no version, and answers with one', async () => {
        const guildId = freshGuild();
        const flowId = await newFlow(guildId);

        const loaded = await send<StoredBody>(guildId, 'GET', `/flows/${flowId}/resources`);
        expect(loaded.body).toEqual({ resources: [], updatedAt: null });

        const saved = await send<StoredBody>(guildId, 'PUT', `/flows/${flowId}/resources`, { resources: [LOBBY] });

        expect(saved.status).toBe(200);
        expect(saved.body.resources).toEqual([LOBBY]);
        expect(saved.body.updatedAt).toEqual(expect.any(String));
        const reread = await send<StoredBody>(guildId, 'GET', `/flows/${flowId}/resources`);
        expect(reread.body.updatedAt).toBe(saved.body.updatedAt);
    });

    it('saves at the current version and answers with a newer one, every time', async () => {
        const guildId = freshGuild();
        const flowId = await newFlow(guildId);
        const first = await send<StoredBody>(guildId, 'PUT', `/flows/${flowId}/resources`, { resources: [LOBBY] });

        const second = await send<StoredBody>(guildId, 'PUT', `/flows/${flowId}/resources`, {
            resources: [LOBBY, DUNGEON],
            baseUpdatedAt: first.body.updatedAt,
        });
        // Back to back, inside one millisecond as often as not: the version still moves.
        const third = await send<StoredBody>(guildId, 'PUT', `/flows/${flowId}/resources`, {
            resources: [LOBBY, DUNGEON, AFTERCARE],
            baseUpdatedAt: second.body.updatedAt,
        });

        expect([second.status, third.status]).toEqual([200, 200]);
        expect(third.body.resources).toEqual([LOBBY, DUNGEON, AFTERCARE]);
        const versions = [first, second, third].map((reply) => Date.parse(reply.body.updatedAt ?? ''));
        expect(versions[1]).toBeGreaterThan(versions[0] ?? Infinity);
        expect(versions[2]).toBeGreaterThan(versions[1] ?? Infinity);
    });

    it('refuses a list edited from a version that has moved on, and writes nothing', async () => {
        const guildId = freshGuild();
        const flowId = await newFlow(guildId);
        const first = await send<StoredBody>(guildId, 'PUT', `/flows/${flowId}/resources`, { resources: [LOBBY] });
        // Another tab saves.
        await send<StoredBody>(guildId, 'PUT', `/flows/${flowId}/resources`, {
            resources: [LOBBY, DUNGEON],
            baseUpdatedAt: first.body.updatedAt,
        });

        const stale = await send<{ error: string }>(guildId, 'PUT', `/flows/${flowId}/resources`, {
            resources: [AFTERCARE],
            baseUpdatedAt: first.body.updatedAt,
        });

        expect(stale.status).toBe(409);
        expect(stale.body.error).toBe(STALE_RESOURCES_MESSAGE);
        expect((await journeysRepo.getByKey(guildId, flowId))?.resources).toEqual([LOBBY, DUNGEON]);
    });

    it('refuses a save with no version onto a journey that exists — a tab older than the guard', async () => {
        const guildId = freshGuild();
        const flowId = await newFlow(guildId);
        await send<StoredBody>(guildId, 'PUT', `/flows/${flowId}/resources`, { resources: [LOBBY] });

        const unversioned = await send<{ error: string }>(guildId, 'PUT', `/flows/${flowId}/resources`, {
            resources: [],
        });

        expect(unversioned.status).toBe(409);
        expect(unversioned.body.error).toBe(STALE_RESOURCES_MESSAGE);
        expect((await journeysRepo.getByKey(guildId, flowId))?.resources).toEqual([LOBBY]);
    });

    /** The stale tab's worst case: an empty list deletes the journey. */
    it('refuses clearing the list from a stale version, and keeps the journey and its link', async () => {
        const guildId = freshGuild();
        const flowId = await newFlow(guildId);
        const first = await send<StoredBody>(guildId, 'PUT', `/flows/${flowId}/resources`, { resources: [LOBBY] });
        await send<StoredBody>(guildId, 'PUT', `/flows/${flowId}/resources`, {
            resources: [LOBBY, DUNGEON],
            baseUpdatedAt: first.body.updatedAt,
        });

        const stale = await send<{ error: string }>(guildId, 'PUT', `/flows/${flowId}/resources`, {
            resources: [],
            baseUpdatedAt: first.body.updatedAt,
        });

        expect(stale.status).toBe(409);
        expect((await journeysRepo.getByKey(guildId, flowId))?.resources).toEqual([LOBBY, DUNGEON]);
        expect(await flowJourneyLinksRepo.getJourneyKeyForFlow(guildId, flowId)).toBe(flowId);
    });

    it('clears the list at the current version: journey and link gone, no version left', async () => {
        const guildId = freshGuild();
        const flowId = await newFlow(guildId);
        const first = await send<StoredBody>(guildId, 'PUT', `/flows/${flowId}/resources`, { resources: [LOBBY] });

        const cleared = await send<StoredBody>(guildId, 'PUT', `/flows/${flowId}/resources`, {
            resources: [],
            baseUpdatedAt: first.body.updatedAt,
        });

        expect(cleared.status).toBe(200);
        expect(cleared.body).toEqual({ resources: [], updatedAt: null });
        expect(await journeysRepo.getByKey(guildId, flowId)).toBeNull();
        expect(await flowJourneyLinksRepo.getJourneyKeyForFlow(guildId, flowId)).toBeNull();
    });

    it('refuses a version sent for a journey that has gone, rather than bringing it back', async () => {
        const guildId = freshGuild();
        const flowId = await newFlow(guildId);
        const first = await send<StoredBody>(guildId, 'PUT', `/flows/${flowId}/resources`, { resources: [LOBBY] });
        // Another tab clears it.
        await send<StoredBody>(guildId, 'PUT', `/flows/${flowId}/resources`, {
            resources: [],
            baseUpdatedAt: first.body.updatedAt,
        });

        const stale = await send<{ error: string }>(guildId, 'PUT', `/flows/${flowId}/resources`, {
            resources: [LOBBY, DUNGEON],
            baseUpdatedAt: first.body.updatedAt,
        });

        expect(stale.status).toBe(409);
        expect(await journeysRepo.getByKey(guildId, flowId)).toBeNull();
    });
});

describe('PUT /journeys/{journeyKey}', () => {
    async function journeyIn(guildId: string): Promise<JourneyBody> {
        const created = await send<JourneyBody>(guildId, 'POST', '/journeys', {
            journeyKey: 'onboarding',
            name: 'Onboarding',
            resources: [LOBBY],
        });
        return created.body;
    }

    it('saves resources at the current version and answers with a newer one', async () => {
        const guildId = freshGuild();
        const loaded = await journeyIn(guildId);

        const saved = await send<JourneyBody>(guildId, 'PUT', '/journeys/onboarding', {
            resources: [LOBBY, DUNGEON],
            baseUpdatedAt: loaded.updatedAt,
        });

        expect(saved.status).toBe(200);
        expect(saved.body.resources).toEqual([LOBBY, DUNGEON]);
        expect(Date.parse(saved.body.updatedAt)).toBeGreaterThan(Date.parse(loaded.updatedAt));
    });

    it('refuses resources edited from a version that has moved on, and writes nothing', async () => {
        const guildId = freshGuild();
        const loaded = await journeyIn(guildId);
        await send<JourneyBody>(guildId, 'PUT', '/journeys/onboarding', {
            resources: [LOBBY, DUNGEON],
            baseUpdatedAt: loaded.updatedAt,
        });

        const stale = await send<{ error: string }>(guildId, 'PUT', '/journeys/onboarding', {
            resources: [AFTERCARE],
            baseUpdatedAt: loaded.updatedAt,
        });

        expect(stale.status).toBe(409);
        expect(stale.body.error).toBe(STALE_RESOURCES_MESSAGE);
        expect((await journeysRepo.getByKey(guildId, 'onboarding'))?.resources).toEqual([LOBBY, DUNGEON]);
    });

    it('refuses resources sent with no version', async () => {
        const guildId = freshGuild();
        await journeyIn(guildId);

        const unversioned = await send<{ error: string }>(guildId, 'PUT', '/journeys/onboarding', {
            resources: [AFTERCARE],
        });

        expect(unversioned.status).toBe(409);
        expect((await journeysRepo.getByKey(guildId, 'onboarding'))?.resources).toEqual([LOBBY]);
    });

    it('renames with no version: a name replaces no list', async () => {
        const guildId = freshGuild();
        await journeyIn(guildId);

        const renamed = await send<JourneyBody>(guildId, 'PUT', '/journeys/onboarding', { name: 'Welcome wagon' });

        expect(renamed.status).toBe(200);
        expect(renamed.body).toMatchObject({ name: 'Welcome wagon', resources: [LOBBY] });
    });
});

describe('POST /flows/{flowId}/group, merging', () => {
    /**
     * The merge builds its list from the destination it read at the top of the request and
     * replaces the destination's whole list with it. A tab's resources save landing in between
     * would be erased with no error anywhere — so the merge writes at the version it read, and
     * a save that moved it on turns the grouping away instead.
     *
     * The save lands while the route checks the moving flow's buttons (it is live, so the
     * check reads the guild's flows): after both journeys were read, before anything is written.
     */
    it('refuses with a 409 when a resources save lands mid-merge, and the save survives', async () => {
        const guildId = freshGuild();
        const targetId = await newFlow(guildId);
        await send<StoredBody>(guildId, 'PUT', `/flows/${targetId}/resources`, { resources: [LOBBY] });
        const movingId = await newFlow(guildId);
        await send<StoredBody>(guildId, 'PUT', `/flows/${movingId}/resources`, { resources: [AFTERCARE] });
        await flowsRepo.update(movingId, { enabled: true });

        const readGuildFlows = flowsRepo.getByGuildId.bind(flowsRepo);
        const midMerge = vi.spyOn(flowsRepo, 'getByGuildId').mockImplementationOnce(async (id) => {
            const target = await journeysRepo.getByKey(guildId, targetId);
            if (!target) throw new Error('The target flow has no journey.');
            await journeysRepo.updateAtVersion(guildId, targetId, journeyVersion(target), { resources: [LOBBY, DUNGEON] });
            return readGuildFlows(id);
        });

        try {
            const grouped = await send<{ error: string }>(guildId, 'POST', `/flows/${movingId}/group`, {
                targetFlowId: targetId,
                resolution: 'merge',
            });

            expect(midMerge).toHaveBeenCalled();
            expect(grouped.status).toBe(409);
            expect(grouped.body.error).toBe(GROUP_CHANGED_MESSAGE);
        } finally {
            midMerge.mockRestore();
        }

        expect((await journeysRepo.getByKey(guildId, targetId))?.resources).toEqual([LOBBY, DUNGEON]);
        expect((await journeysRepo.getByKey(guildId, movingId))?.resources).toEqual([AFTERCARE]);
        expect(await flowJourneyLinksRepo.getJourneyKeyForFlow(guildId, movingId)).toBe(movingId);
    });
});
