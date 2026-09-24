import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FlowsRepo } from '../../../features/flows/data/flowsRepo';
import type { FlowJourneyLinksRepo } from '../../../features/provisioning/data/flowJourneyLinksRepo';
import type { JourneysRepo } from '../../../features/provisioning/data/journeysRepo';
import type { JourneyEntity } from '../../../features/provisioning/data/journeysSchema';
import type { ResourceBindingsRepo } from '../../../features/provisioning/data/resourceBindingsRepo';
import type { ResourceBindingEntity } from '../../../features/provisioning/data/resourceBindingsSchema';
import type { ResourceDeclaration } from '../../../features/provisioning/logic/resourceDeclaration';
import type { AppEnv } from '../../types';

/**
 * Grouping one flow with another — the flows page's drag, previewed and then committed.
 *
 * **What these tests own, and what they deliberately do not.** The merge arithmetic —
 * which resources move, which collide, which are live enough to be orphaned — is
 * `planJourneyMerge`, and it is settled against its own cases in
 * `provisioning/logic/__tests__/journeyMergePlan.test.ts`. Re-asserting it through HTTP
 * would test the same pure function twice and the routes once.
 *
 * What is only testable here is everything the routes decide *around* that plan, and it
 * is the consequential half:
 *
 *  - **guild scoping**, where a mismatch must be a 404 and must not confirm that another
 *    guild's flow exists,
 *  - **the shared-journey refusal**, because a journey holding two flows cannot follow
 *    one of them away and `planJourneyMerge` is pure and cannot ask who else is attached,
 *  - **the missing-`resolution` refusal**, which is the guard standing between an
 *    operator's drag and a silent `leave` that abandons live channels, and
 *  - **what the commit leaves alone** — the moving flow's old journey row and its
 *    `resource_bindings`, which name real Discord objects.
 *
 * The repos are mocked for the same reason the sibling suites mock them: whether the rows
 * store is settled against real SQL in the integration suites. `resolveFlowJourney` and
 * `otherFlowsOnJourney` run for real over those mocks, because which journey a flow is on
 * and who else holds it are exactly what these routes report and refuse on.
 */

/**
 * The mocks are typed against the real repos.
 *
 * `vi.mock` swaps a module wholesale and TypeScript never compares the replacement to
 * what it replaced, so an untyped mock keeps a suite green against a method that has been
 * renamed or has grown a parameter. Pinning each to a `Pick` of the real class turns that
 * drift into a build error instead of a test that passes against a repo nobody ships.
 */
const journeysRepoMock = {
    listByGuildId: vi.fn(),
    getByKey: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    deleteByKey: vi.fn(),
} satisfies Record<keyof Pick<
    JourneysRepo,
    'listByGuildId' | 'getByKey' | 'create' | 'update' | 'deleteByKey'
>, unknown>;

const flowsRepoMock = {
    getByFlowId: vi.fn(),
    getByGuildId: vi.fn(),
} satisfies Record<keyof Pick<FlowsRepo, 'getByFlowId' | 'getByGuildId'>, unknown>;

class DuplicateJourneyKeyError extends Error {}

vi.mock('../../../features/flows/data/flowsRepo', () => ({ flowsRepo: flowsRepoMock }));
vi.mock('../../../features/provisioning/data/journeysRepo', () => ({
    journeysRepo: journeysRepoMock,
    DuplicateJourneyKeyError,
}));

const linksRepo = {
    getJourneyKeyForFlow: vi.fn(),
    listFlowIdsForJourney: vi.fn(),
    listLinksForGuild: vi.fn(),
    attach: vi.fn(),
    detachFlow: vi.fn(),
} satisfies Record<keyof Pick<
    FlowJourneyLinksRepo,
    'getJourneyKeyForFlow' | 'listFlowIdsForJourney' | 'listLinksForGuild' | 'attach' | 'detachFlow'
>, unknown>;

vi.mock('../../../features/provisioning/data/flowJourneyLinksRepo', () => ({
    flowJourneyLinksRepo: linksRepo,
}));

/**
 * Mocked unlike in the sibling suites, which never reach it — the preview reads bindings
 * to decide which resources are *live*, and the real repo would open the database.
 *
 * `forget` and `discardIntent` are stubbed although the routes must never call them: that
 * is precisely the assertion, and a mock without them would pass by throwing.
 */
const bindingsRepo = {
    listByJourney: vi.fn(),
    forget: vi.fn(),
    discardIntent: vi.fn(),
} satisfies Record<keyof Pick<
    ResourceBindingsRepo,
    'listByJourney' | 'forget' | 'discardIntent'
>, unknown>;

vi.mock('../../../features/provisioning/data/resourceBindingsRepo', () => ({
    resourceBindingsRepo: bindingsRepo,
}));

const { journeyRoutes } = await import('../journeyRoutes');

const GUILD_ID = 'guild-1';
const OTHER_GUILD = 'someone-elses-guild';
/** The flow being dragged. */
const MOVING_FLOW_ID = '11111111-2222-3333-4444-555555555555';
/** The row it was dropped on. */
const TARGET_FLOW_ID = '99999999-8888-7777-6666-555555555555';

function declaration(overrides: Partial<ResourceDeclaration> = {}): ResourceDeclaration {
    return {
        key: 'qa-channel',
        kind: 'textChannel',
        defaultName: 'questions',
        ...overrides,
    };
}

/**
 * Typed as the real `Selectable` row, `id` included.
 *
 * An untyped fixture compiles whatever it is handed, so it would keep passing against a
 * shape no query could return — and the first route to read a column it omits would find
 * `undefined` here and a real value in production.
 */
function journeyRow(overrides: Partial<JourneyEntity> = {}): JourneyEntity {
    return {
        id: 1,
        journeyKey: 'onboarding',
        guildId: GUILD_ID,
        name: 'Onboarding',
        description: null,
        createdForFlowId: null,
        resources: [declaration()],
        createdAt: new Date('2026-09-19T10:00:00Z'),
        updatedAt: new Date('2026-09-19T10:00:00Z'),
        ...overrides,
    };
}

function bindingRow(overrides: Partial<ResourceBindingEntity> = {}): ResourceBindingEntity {
    return {
        id: 1,
        guildId: GUILD_ID,
        journeyKey: 'onboarding',
        resourceKey: 'qa-channel',
        kind: 'textChannel',
        state: 'created',
        discordId: '123456789012345678',
        name: 'questions',
        createdAt: new Date('2026-09-19T10:00:00Z'),
        updatedAt: new Date('2026-09-19T10:00:00Z'),
        ...overrides,
    };
}

function app() {
    const outer = new Hono<AppEnv>();
    outer.use('*', async (c, next) => {
        c.set('guild', { id: GUILD_ID } as never);
        await next();
    });
    outer.route('/', journeyRoutes());
    return outer;
}

function preview(target: string | null, flowId: string = MOVING_FLOW_ID) {
    const query = target === null ? '' : `?target=${encodeURIComponent(target)}`;
    return app().request(`/${GUILD_ID}/flows/${flowId}/group-preview${query}`);
}

/**
 * The group request body, typed against the route's schema rather than left open.
 *
 * `Record<string, unknown>` would accept `resolution: 'mrege'` and quietly produce the
 * 400 a test is asserting, so the assertion would hold for a reason it never intended.
 * Every field stays optional because the omissions are exactly what several tests drive.
 */
interface GroupRequestBody {
    readonly targetFlowId?: string;
    readonly resolution?: 'merge' | 'leave';
    readonly newJourneyKey?: string;
    readonly newJourneyName?: string;
}

function group(body: GroupRequestBody, flowId: string = MOVING_FLOW_ID) {
    return app().request(`/${GUILD_ID}/flows/${flowId}/group`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
    });
}

/**
 * Attach a flow to a journey in the mocked link table.
 *
 * `resolveFlowJourney` reads the link row and then the journey, and `otherFlowsOnJourney`
 * reads who shares the key, so the three mocks have to agree or the routes resolve
 * something no arrangement of real rows could produce.
 */
function attachFlows(attachments: Record<string, string>, journeys: Record<string, JourneyEntity>) {
    linksRepo.getJourneyKeyForFlow.mockImplementation(
        async (_guildId: string, flowId: string) => attachments[flowId] ?? null
    );
    journeysRepoMock.getByKey.mockImplementation(
        async (_guildId: string, journeyKey: string) => journeys[journeyKey] ?? null
    );
    linksRepo.listFlowIdsForJourney.mockImplementation(async (_guildId: string, journeyKey: string) =>
        Object.entries(attachments)
            .filter(([, key]) => key === journeyKey)
            .map(([flowId]) => flowId)
    );
}

beforeEach(() => {
    vi.clearAllMocks();
    flowsRepoMock.getByFlowId.mockImplementation(async (flowId: string) =>
        flowId === MOVING_FLOW_ID
            ? { flowId, guildId: GUILD_ID, name: 'Welcome wagon' }
            : { flowId, guildId: GUILD_ID, name: 'Age check' }
    );
    // Neither flow is on a journey unless a test says so — the common case, and the one
    // where a drag is a silent move.
    attachFlows({}, {});
    bindingsRepo.listByJourney.mockResolvedValue([]);
    // `update` returns the merged row, so a route that reads its result back gets a row
    // rather than undefined.
    journeysRepoMock.update.mockImplementation(
        async (_guildId: string, journeyKey: string, patch: { resources?: ResourceDeclaration[] }) =>
            journeyRow({ journeyKey, resources: patch.resources ?? [] })
    );
    journeysRepoMock.create.mockImplementation(
        async (input: { journeyKey: string; name: string; resources: ResourceDeclaration[] }) =>
            journeyRow({ journeyKey: input.journeyKey, name: input.name, resources: input.resources })
    );
});

describe('previewing a group', () => {
    it('refuses without a target flow rather than guessing one', async () => {
        const response = await preview(null);

        expect(response.status).toBe(400);
        expect(flowsRepoMock.getByFlowId).not.toHaveBeenCalled();
    });

    it('refuses to group a flow with itself', async () => {
        const response = await preview(MOVING_FLOW_ID);

        expect(response.status).toBe(400);
        // Rejected on the ids alone, before anything is read: a self-group has no
        // coherent plan to compute.
        expect(flowsRepoMock.getByFlowId).not.toHaveBeenCalled();
    });

    /**
     * 404 rather than 403, in both directions.
     *
     * `flowsRepo.getByFlowId` matches on the id alone, so guild scoping is the route's
     * job — and the status has to be the same one a genuinely absent flow gets, or the
     * difference between them tells an operator that a flow they cannot see exists.
     */
    it("refuses another guild's flow without confirming it exists", async () => {
        flowsRepoMock.getByFlowId.mockImplementation(async (flowId: string) =>
            flowId === MOVING_FLOW_ID
                ? { flowId, guildId: OTHER_GUILD, name: 'Their private flow' }
                : { flowId, guildId: GUILD_ID, name: 'Age check' }
        );

        const response = await preview(TARGET_FLOW_ID);
        const body = (await response.json()) as { error: string };

        expect(response.status).toBe(404);
        expect(body.error).toBe('Flow not found.');
        expect(body.error).not.toContain('Their private flow');
    });

    it("refuses a target flow in another guild without confirming it exists", async () => {
        flowsRepoMock.getByFlowId.mockImplementation(async (flowId: string) =>
            flowId === TARGET_FLOW_ID
                ? { flowId, guildId: OTHER_GUILD, name: 'Their private flow' }
                : { flowId, guildId: GUILD_ID, name: 'Welcome wagon' }
        );

        const response = await preview(TARGET_FLOW_ID);
        const body = (await response.json()) as { error: string };

        expect(response.status).toBe(404);
        expect(body.error).toBe('Flow not found.');
        expect(body.error).not.toContain('Their private flow');
    });

    /**
     * **A shared journey cannot follow one flow away.**
     *
     * The other flows attached to it still install it, so moving this one would either
     * take their resources with it or leave them pointing at a journey that changed
     * underneath them. Refused before a plan is computed, since `planJourneyMerge` is
     * pure and has no way to ask who else is attached.
     *
     * The refusal **names** the other flow, which is the house convention
     * (`sharedJourneyGuard`, `buildUnpublishPlan`): a count tells an operator the size of
     * a problem they then have to go and find.
     */
    it('refuses to move a journey that other flows still install, naming them', async () => {
        attachFlows(
            {
                [MOVING_FLOW_ID]: 'onboarding',
                'flow-sharer': 'onboarding',
            },
            { onboarding: journeyRow() }
        );
        flowsRepoMock.getByFlowId.mockImplementation(async (flowId: string) => {
            const names: Record<string, string> = {
                [MOVING_FLOW_ID]: 'Welcome wagon',
                [TARGET_FLOW_ID]: 'Age check',
                'flow-sharer': 'Rules acceptance',
            };
            return { flowId, guildId: GUILD_ID, name: names[flowId] ?? flowId };
        });

        const response = await preview(TARGET_FLOW_ID);
        const body = (await response.json()) as { error: string };

        expect(response.status).toBe(409);
        expect(body.error).toContain('Rules acceptance');
        expect(body.error).toContain('Onboarding');
    });

    /**
     * A target with no journey is the ordinary case for the first drag in a server, and
     * `destination: null` is how the dialog knows to ask for a name instead of naming one.
     */
    it('reports a null destination when the target has no journey yet', async () => {
        attachFlows({ [MOVING_FLOW_ID]: 'onboarding' }, { onboarding: journeyRow() });

        const response = await preview(TARGET_FLOW_ID);
        const body = (await response.json()) as {
            destination: unknown;
            destinationName: string;
            canMerge: boolean;
        };

        expect(response.status).toBe(200);
        expect(body.destination).toBeNull();
        // Nothing on the other side to collide with, so the merge is always expressible.
        expect(body.canMerge).toBe(true);
        // The target flow's own name stands in, so the dialog has something to call the
        // group that does not yet exist.
        expect(body.destinationName).toBe('Age check');
    });

    /**
     * The loud half of the dialog: a resource that is **live in the guild**.
     *
     * "Leave them behind" is a legitimate choice, but for an installed resource it means
     * a channel stays in the server with nothing left that knows this bot created it. The
     * preview names those so the dialog can say which.
     */
    it('names the live resources that leaving them behind would orphan', async () => {
        // The target gets a journey of its own so the binding read below has two keys it
        // could plausibly have used. With only one in existence the assertion that it
        // read the *source* key would hold no matter which key the route asked for.
        attachFlows(
            {
                [MOVING_FLOW_ID]: 'onboarding',
                [TARGET_FLOW_ID]: 'the-group',
            },
            {
                onboarding: journeyRow(),
                'the-group': journeyRow({
                    journeyKey: 'the-group',
                    name: 'The Group',
                    resources: [declaration({ key: 'rules-channel', defaultName: 'rules' })],
                }),
            }
        );
        bindingsRepo.listByJourney.mockResolvedValue([
            bindingRow({ name: 'questions-live' }),
        ]);

        const body = (await (await preview(TARGET_FLOW_ID)).json()) as {
            orphaned: { key: string; live: { discordId: string; name: string } | null }[];
        };

        expect(body.orphaned).toEqual([
            expect.objectContaining({
                key: 'qa-channel',
                live: { discordId: '123456789012345678', name: 'questions-live' },
            }),
        ]);
        // Read under the *source* journey's key — bindings are keyed by journey, so the
        // destination's would describe resources this flow is not moving.
        expect(bindingsRepo.listByJourney).toHaveBeenCalledWith(GUILD_ID, 'onboarding');
        expect(bindingsRepo.listByJourney).not.toHaveBeenCalledWith(GUILD_ID, 'the-group');
    });
});

describe('committing a group', () => {
    it('refuses a body with no target flow', async () => {
        const response = await group({});

        expect(response.status).toBe(400);
        expect(linksRepo.attach).not.toHaveBeenCalled();
        expect(journeysRepoMock.create).not.toHaveBeenCalled();
    });

    /**
     * The commit path carries its own self-group guard, separate from the preview's, and
     * so it needs its own test — covering only the preview leaves the write side free.
     *
     * Unguarded this does not error: it creates a journey and attaches the same flow
     * twice, persisting a "group" of one and reporting 200. Driven with no resolution and
     * no resources, because the `merge` path masks the bug behind an incidental collision
     * 409 and the quiet paths are the ones that would ship it.
     */
    it('refuses to group a flow with itself rather than making a group of one', async () => {
        const response = await group({
            targetFlowId: MOVING_FLOW_ID,
            newJourneyKey: 'the-group',
        });

        expect(response.status).toBe(400);
        expect(journeysRepoMock.create).not.toHaveBeenCalled();
        expect(linksRepo.attach).not.toHaveBeenCalled();
    });

    /**
     * **The guard that stands between a drag and abandoned channels.**
     *
     * `resolution` has no default on purpose. `leave` walks away from resources that may
     * be live in the guild and `merge` rewrites the destination's declarations — both are
     * consequential, so an omitted answer is a 400 rather than an assumed one. A default
     * here would make the destructive choice the quiet one.
     *
     * Asserted as "nothing was written" rather than only on the status, because a route
     * that refused *after* creating the journey would still return 400.
     */
    it('refuses to move a flow that declares resources without an explicit resolution', async () => {
        attachFlows({ [MOVING_FLOW_ID]: 'onboarding' }, { onboarding: journeyRow() });

        const response = await group({ targetFlowId: TARGET_FLOW_ID, newJourneyKey: 'the-group' });
        const body = (await response.json()) as { error: string };

        expect(response.status).toBe(400);
        expect(body.error).toContain('merge');
        expect(body.error).toContain('leave');
        expect(linksRepo.attach).not.toHaveBeenCalled();
        expect(journeysRepoMock.create).not.toHaveBeenCalled();
        expect(journeysRepoMock.update).not.toHaveBeenCalled();
    });

    /**
     * The same omission is fine when there is nothing to resolve — a flow declaring
     * nothing has no resources to merge or leave, and that is the common, silent drag.
     */
    it('allows the resolution to be omitted when the flow declares nothing', async () => {
        const response = await group({ targetFlowId: TARGET_FLOW_ID, newJourneyKey: 'the-group' });

        expect(response.status).toBe(200);
        expect(linksRepo.attach).toHaveBeenCalledWith({
            guildId: GUILD_ID,
            flowId: MOVING_FLOW_ID,
            journeyKey: 'the-group',
        });
        // Unnamed, so the new journey falls back to the **target** flow's name — the row
        // that was dropped on, which is what the preview's `destinationName` already
        // promised the operator. Falling back to the dragged flow's name instead would
        // make the dialog and the stored row disagree.
        expect(journeysRepoMock.create).toHaveBeenCalledWith(
            expect.objectContaining({ name: 'Age check' })
        );
    });

    it("refuses another guild's flow without confirming it exists", async () => {
        flowsRepoMock.getByFlowId.mockImplementation(async (flowId: string) =>
            flowId === MOVING_FLOW_ID
                ? { flowId, guildId: OTHER_GUILD, name: 'Their private flow' }
                : { flowId, guildId: GUILD_ID, name: 'Age check' }
        );

        const response = await group({ targetFlowId: TARGET_FLOW_ID, newJourneyKey: 'the-group' });
        const body = (await response.json()) as { error: string };

        expect(response.status).toBe(404);
        expect(body.error).toBe('Flow not found.');
        expect(linksRepo.attach).not.toHaveBeenCalled();
    });

    it("refuses a target flow in another guild without confirming it exists", async () => {
        flowsRepoMock.getByFlowId.mockImplementation(async (flowId: string) =>
            flowId === TARGET_FLOW_ID
                ? { flowId, guildId: OTHER_GUILD, name: 'Their private flow' }
                : { flowId, guildId: GUILD_ID, name: 'Welcome wagon' }
        );

        const response = await group({ targetFlowId: TARGET_FLOW_ID, newJourneyKey: 'the-group' });

        expect(response.status).toBe(404);
        expect(linksRepo.attach).not.toHaveBeenCalled();
    });

    /**
     * Re-checked here and not trusted from the preview: that was a separate request, and
     * another flow could have attached to the journey in between.
     */
    it('refuses to move a journey that other flows still install, naming them', async () => {
        attachFlows(
            {
                [MOVING_FLOW_ID]: 'onboarding',
                'flow-sharer': 'onboarding',
            },
            { onboarding: journeyRow() }
        );
        flowsRepoMock.getByFlowId.mockImplementation(async (flowId: string) => {
            const names: Record<string, string> = {
                [MOVING_FLOW_ID]: 'Welcome wagon',
                [TARGET_FLOW_ID]: 'Age check',
                'flow-sharer': 'Rules acceptance',
            };
            return { flowId, guildId: GUILD_ID, name: names[flowId] ?? flowId };
        });

        const response = await group({
            targetFlowId: TARGET_FLOW_ID,
            resolution: 'merge',
            newJourneyKey: 'the-group',
        });
        const body = (await response.json()) as { error: string };

        expect(response.status).toBe(409);
        expect(body.error).toContain('Rules acceptance');
        expect(linksRepo.attach).not.toHaveBeenCalled();
        expect(journeysRepoMock.create).not.toHaveBeenCalled();
    });

    /**
     * **Creating a group attaches both flows, not just the one that moved.**
     *
     * The target had no journey, so the new one is created for the pair — and if only the
     * dragged flow were attached, the operator would have made a "group" that the flow
     * they dropped onto is not in. The target's membership is invisible in the response,
     * which is exactly why it is asserted on the write.
     *
     * One route rather than the client orchestrating create-then-attach: a crash between
     * those two leaves a journey nothing is attached to.
     */
    it('creates the journey and attaches both flows to it', async () => {
        const response = await group({
            targetFlowId: TARGET_FLOW_ID,
            newJourneyKey: 'the-group',
            newJourneyName: 'The Group',
        });

        expect(response.status).toBe(200);
        expect(journeysRepoMock.create).toHaveBeenCalledWith(
            expect.objectContaining({
                guildId: GUILD_ID,
                journeyKey: 'the-group',
                name: 'The Group',
            })
        );
        expect(linksRepo.attach).toHaveBeenCalledWith({
            guildId: GUILD_ID,
            flowId: TARGET_FLOW_ID,
            journeyKey: 'the-group',
        });
        expect(linksRepo.attach).toHaveBeenCalledWith({
            guildId: GUILD_ID,
            flowId: MOVING_FLOW_ID,
            journeyKey: 'the-group',
        });
        expect(linksRepo.attach).toHaveBeenCalledTimes(2);
    });

    it('refuses to create a group without a key for the new journey', async () => {
        const response = await group({ targetFlowId: TARGET_FLOW_ID });

        expect(response.status).toBe(400);
        expect(journeysRepoMock.create).not.toHaveBeenCalled();
    });

    /**
     * A key the guild already uses is an ordinary operator typo, and `errorResponse` maps
     * it to a 409 by `instanceof`.
     *
     * Worth a test because that mapping is only correct while the thrown class is the one
     * the route imports: an unrecognised error is rethrown, so a mismatch surfaces as a
     * 500 rather than something the dialog can show.
     */
    it('reports a duplicate journey key as a conflict rather than a server error', async () => {
        journeysRepoMock.create.mockRejectedValue(new DuplicateJourneyKeyError('duplicate'));

        const response = await group({ targetFlowId: TARGET_FLOW_ID, newJourneyKey: 'taken' });

        expect(response.status).toBe(409);
        expect(linksRepo.attach).not.toHaveBeenCalled();
    });

    it("merging concatenates the moving declarations onto the destination's", async () => {
        const movingResource = declaration({ key: 'qa-channel', defaultName: 'questions' });
        const destinationResource = declaration({ key: 'rules-channel', defaultName: 'rules' });
        attachFlows(
            {
                [MOVING_FLOW_ID]: 'onboarding',
                [TARGET_FLOW_ID]: 'the-group',
            },
            {
                onboarding: journeyRow({ resources: [movingResource] }),
                'the-group': journeyRow({
                    journeyKey: 'the-group',
                    name: 'The Group',
                    resources: [destinationResource],
                }),
            }
        );

        const response = await group({ targetFlowId: TARGET_FLOW_ID, resolution: 'merge' });

        expect(response.status).toBe(200);
        // Destination first, then what arrived — the destination's existing declarations
        // are added to, never replaced.
        expect(journeysRepoMock.update).toHaveBeenCalledWith(GUILD_ID, 'the-group', {
            resources: [destinationResource, movingResource],
        });
        // The flow itself has to follow its declarations. Moving the resources without
        // moving the link is the two-writes-disagreeing outcome this route exists to
        // prevent, and it is invisible in the response body, which is built from the
        // destination journey either way.
        expect(linksRepo.attach).toHaveBeenCalledWith({
            guildId: GUILD_ID,
            flowId: MOVING_FLOW_ID,
            journeyKey: 'the-group',
        });
    });

    /**
     * `leave` is the other half of the operator's choice, and it must touch the
     * destination not at all: the flow joins the group and simply stops declaring what it
     * used to.
     */
    it("leaving the resources behind does not modify the destination's declarations", async () => {
        attachFlows(
            {
                [MOVING_FLOW_ID]: 'onboarding',
                [TARGET_FLOW_ID]: 'the-group',
            },
            {
                onboarding: journeyRow({ resources: [declaration()] }),
                'the-group': journeyRow({
                    journeyKey: 'the-group',
                    name: 'The Group',
                    resources: [declaration({ key: 'rules-channel', defaultName: 'rules' })],
                }),
            }
        );

        const response = await group({ targetFlowId: TARGET_FLOW_ID, resolution: 'leave' });

        expect(response.status).toBe(200);
        expect(journeysRepoMock.update).not.toHaveBeenCalled();
        expect(linksRepo.attach).toHaveBeenCalledWith({
            guildId: GUILD_ID,
            flowId: MOVING_FLOW_ID,
            journeyKey: 'the-group',
        });
    });

    /**
     * **The moving flow's old journey survives the move, and so do its bindings.**
     *
     * Deliberate, and the most expensive thing to get wrong here. `resource_bindings`
     * under the old key name channels and roles that exist in the guild right now;
     * deleting the journey row they hang off would strand them with nothing able to
     * resolve them, and forgetting the bindings would orphan the Discord objects
     * outright. Tearing those down is `/unpublish`'s job and an operator has to ask for
     * it — the same rule `/detach` and `deleteByKey` already follow.
     *
     * Asserted under `leave`, which is the resolution where the old journey is most
     * plausibly "finished" and therefore the one where a cleanup would be tempting.
     */
    it('leaves the old journey row and its bindings untouched', async () => {
        attachFlows(
            {
                [MOVING_FLOW_ID]: 'onboarding',
                [TARGET_FLOW_ID]: 'the-group',
            },
            {
                onboarding: journeyRow({ resources: [declaration()] }),
                'the-group': journeyRow({
                    journeyKey: 'the-group',
                    name: 'The Group',
                    resources: [],
                }),
            }
        );
        bindingsRepo.listByJourney.mockResolvedValue([bindingRow()]);

        const response = await group({ targetFlowId: TARGET_FLOW_ID, resolution: 'leave' });

        expect(response.status).toBe(200);
        expect(journeysRepoMock.deleteByKey).not.toHaveBeenCalled();
        // The link is an upsert, so the move is one statement and never a detach.
        expect(linksRepo.detachFlow).not.toHaveBeenCalled();
        expect(bindingsRepo.forget).not.toHaveBeenCalled();
        expect(bindingsRepo.discardIntent).not.toHaveBeenCalled();
    });

    /**
     * A key both journeys declare is refused rather than resolved, and the refusal
     * **names the key** so the operator knows which one to rename.
     *
     * Merging a collision would make an existing defect permanent: `applyResourcesToFlows`
     * matches on the bare key across the guild, so one journey's install writes its
     * snowflake into flows attached to the other.
     */
    it('refuses a merge when both journeys declare the same key, naming it', async () => {
        const collidingKey = 'qa-channel';
        attachFlows(
            {
                [MOVING_FLOW_ID]: 'onboarding',
                [TARGET_FLOW_ID]: 'the-group',
            },
            {
                onboarding: journeyRow({
                    resources: [declaration({ key: collidingKey, defaultName: 'questions' })],
                }),
                'the-group': journeyRow({
                    journeyKey: 'the-group',
                    name: 'The Group',
                    resources: [declaration({ key: collidingKey, defaultName: 'ask-here' })],
                }),
            }
        );

        const response = await group({ targetFlowId: TARGET_FLOW_ID, resolution: 'merge' });
        const body = (await response.json()) as { error: string };

        expect(response.status).toBe(409);
        expect(body.error).toContain(collidingKey);
        // Refused before anything is written, so a retry after a rename starts clean.
        expect(journeysRepoMock.update).not.toHaveBeenCalled();
        expect(linksRepo.attach).not.toHaveBeenCalled();
    });

    /**
     * A merge moves declarations; it does not copy them.
     *
     * This is the round trip, and it is here because the one-way assertions all passed
     * while the feature was broken. "The destination gained the resources" was true and
     * "the source row is not deleted" was true; what neither asked is what the pair
     * means together. It meant the source kept its copies, and since `/detach` only
     * removes a link, `resolveFlowJourney`'s `journeyKey === flowId` fallback handed
     * them straight back — group then ungroup left one category declared by two
     * journeys, both naming one real channel. Found in live testing, not here.
     */
    it('empties the source journey when a merge moves its resources', async () => {
        const movingKey = 'ticket-area';
        attachFlows(
            { [MOVING_FLOW_ID]: 'tickets', [TARGET_FLOW_ID]: 'onboarding' },
            {
                tickets: journeyRow({
                    journeyKey: 'tickets',
                    resources: [declaration({ key: movingKey, defaultName: 'Tickets' })],
                }),
                onboarding: journeyRow({
                    journeyKey: 'onboarding',
                    resources: [declaration({ key: 'welcome-channel', defaultName: 'welcome' })],
                }),
            }
        );

        const response = await group({ targetFlowId: TARGET_FLOW_ID, resolution: 'merge' });

        expect(response.status).toBe(200);
        // The destination gained it...
        expect(journeysRepoMock.update).toHaveBeenCalledWith(
            GUILD_ID,
            'onboarding',
            expect.objectContaining({
                resources: expect.arrayContaining([
                    expect.objectContaining({ key: movingKey }),
                ]),
            })
        );
        // ...and the source no longer declares it, so nothing can hand it back.
        expect(journeysRepoMock.update).toHaveBeenCalledWith(GUILD_ID, 'tickets', {
            resources: [],
        });
    });

    /**
     * The counterpart, and the reason the emptying is conditional rather than
     * unconditional: "leave them behind" is the operator choosing to strand them, which
     * the dialog spells out in red and names every object for. Emptying the source there
     * would silently drop the record of live channels the operator was told would stay.
     */
    it('leaves the source journey populated when the operator leaves resources behind', async () => {
        attachFlows(
            { [MOVING_FLOW_ID]: 'tickets', [TARGET_FLOW_ID]: 'onboarding' },
            {
                tickets: journeyRow({
                    journeyKey: 'tickets',
                    resources: [declaration({ key: 'ticket-area', defaultName: 'Tickets' })],
                }),
                onboarding: journeyRow({ journeyKey: 'onboarding', resources: [] }),
            }
        );

        const response = await group({ targetFlowId: TARGET_FLOW_ID, resolution: 'leave' });

        expect(response.status).toBe(200);
        expect(journeysRepoMock.update).not.toHaveBeenCalledWith(
            GUILD_ID,
            'tickets',
            expect.anything()
        );
    });

    /**
     * Grouping two flows that declare nothing yet.
     *
     * Refused outright in live testing with "Journey ... declares no resources, so
     * installing it would do nothing" — `validateJourneyDeclaration` rejecting an empty
     * journey on `journeysRepo.create`. That rule was written about *installing* and was
     * enforced on every write, so two empty flows could not be grouped at all. Emptiness
     * is now `assertInstallable`'s question, asked at install.
     */
    it('groups two flows that declare no resources at all', async () => {
        const response = await group({
            targetFlowId: TARGET_FLOW_ID,
            newJourneyKey: 'age-check',
            newJourneyName: 'Age check',
        });

        expect(response.status).toBe(200);
        expect(journeysRepoMock.create).toHaveBeenCalledWith(
            expect.objectContaining({ journeyKey: 'age-check', resources: [] })
        );
        // Both flows land on it — the target is not left behind by its own group.
        expect(linksRepo.attach).toHaveBeenCalledWith(
            expect.objectContaining({ flowId: TARGET_FLOW_ID, journeyKey: 'age-check' })
        );
        expect(linksRepo.attach).toHaveBeenCalledWith(
            expect.objectContaining({ flowId: MOVING_FLOW_ID, journeyKey: 'age-check' })
        );
    });
});
