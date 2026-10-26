import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import type { AppEnv } from '../../types';
import { flowRoutes } from '../flowRoutes';
import { journeyRoutes } from '../journeyRoutes';
import { buildOpenApiDocument } from '../openApiDocument';

/**
 * Deploy is retired (step 3, `docs/plans/message-resource-step-3.md`, "Retiring Deploy"): a
 * trigger listens to a journey message's button, which install posts. Its three routes —
 * post a flow's buttons, take them down, take a journey's down — answer 404 now.
 *
 * Both routers are mounted as `/api/guilds` mounts them, with the guild already resolved, so
 * a 404 here is the routers serving nothing at those paths rather than a refused session. No
 * handler runs, so nothing is mocked.
 */

const GUILD_ID = '111111111111111111';
const FLOW_ID = '11111111-2222-3333-4444-555555555555';

/** The retired operations and the paths they answered at, as the last build before step 3 served them. */
const RETIRED = [
    { operationId: 'deployFlow', path: `/${GUILD_ID}/flows/${FLOW_ID}/deploy` },
    { operationId: 'undeployFlow', path: `/${GUILD_ID}/flows/${FLOW_ID}/undeploy` },
    { operationId: 'undeployJourney', path: `/${GUILD_ID}/journeys/onboarding/undeploy` },
] as const;

function app(): Hono<AppEnv> {
    const outer = new Hono<AppEnv>();
    outer.use('*', async (c, next) => {
        c.set('guild', { id: GUILD_ID } as never);
        await next();
    });
    outer.route('/', flowRoutes());
    outer.route('/', journeyRoutes());
    return outer;
}

async function postEmpty(path: string): Promise<Response> {
    return app().request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
}

describe('the retired Deploy routes', () => {
    it('are looked for on a mount that serves both routers', async () => {
        // The positive control for the 404s below: an empty create reaches each router's
        // validator and is refused there, before any handler or database.
        expect((await postEmpty(`/${GUILD_ID}/flows`)).status).toBe(400);
        expect((await postEmpty(`/${GUILD_ID}/journeys`)).status).toBe(400);
    });

    it.each(RETIRED)('answers 404 for $operationId', async ({ path }) => {
        expect((await postEmpty(path)).status).toBe(404);
    });

    it('leaves them out of the spec, beside the uninstall routes that stay', async () => {
        // The routes that stay are the positive control: a spec read that found nothing would
        // also lack the retired ones.
        const operationIds = Object.values((await buildOpenApiDocument()).paths ?? {}).flatMap((item) =>
            Object.values(item ?? {}).flatMap((operation) =>
                operation && typeof operation === 'object' && 'operationId' in operation ? [operation.operationId] : []
            )
        );

        expect(operationIds).toEqual(expect.arrayContaining(['unpublishFlow', 'unpublishJourney']));
        for (const { operationId } of RETIRED) {
            expect(operationIds).not.toContain(operationId);
        }
    });
});
