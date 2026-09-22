import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FLOW_GRAPH_VERSION } from '../../../features/flows/data/flowGraph';
import type { InstallPlan } from '../../../features/provisioning/logic/installPlan';
import type { ApplyInstallPlanResult } from '../../../features/provisioning/logic/applyInstallPlan';
import type { ResourceWriteBackResult } from '../../../features/provisioning/resourceWriteBack';
import type { AppEnv } from '../../types';

/**
 * The web install half: `GET /install-plan` and `POST /install`.
 *
 * What is under test is what the *route* decides, so the provisioning service is
 * mocked and the guild is injected — `flowRoutes()` is a bare Hono app and auth and
 * guild resolution are applied where it is mounted. The install engine itself is
 * settled by its own tests; the questions here are the ones only this layer answers:
 * whose journey may be installed from this URL, whether the browser can influence what
 * gets applied, and whether a partial install is reported as the legitimate state it is
 * rather than as a failure.
 */

const flowsRepoMock = {
    getByFlowId: vi.fn(),
    getByGuildId: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    deleteByFlowId: vi.fn(),
};

const journeysRepoMock = {
    getByKey: vi.fn(),
};

const previewInstallMock = vi.fn();
const installJourneyMock = vi.fn();
const runResourceWriteBackMock = vi.fn();

const guildSettingsRepoMock = {
    getStaffRoleIds: vi.fn(),
};

vi.mock('../../../features-system/guild-settings', () => ({
    guildSettingsRepo: guildSettingsRepoMock,
}));

vi.mock('../../../features/flows/data/flowsRepo', () => ({ flowsRepo: flowsRepoMock }));
vi.mock('../../../features/provisioning/data/journeysRepo', async (importOriginal) => {
    // `toDeclarationFromRow` is a pure mapper the route uses to turn a row into the
    // planner's input. Mocking it away would leave the route mapping `undefined`, so
    // only the repo is replaced.
    const actual = await importOriginal<
        typeof import('../../../features/provisioning/data/journeysRepo')
    >();
    return { ...actual, journeysRepo: journeysRepoMock };
});

/**
 * The link repo. `resolveFlowJourney` itself runs for real over this and the journeys
 * mock, because which journey a flow may install is exactly what these cases are
 * about — stubbing the resolver would test a resolution rule nothing implements.
 */
const flowJourneyLinksRepoMock = {
    getJourneyKeyForFlow: vi.fn(),
    listFlowIdsForJourney: vi.fn(),
    attach: vi.fn(),
    detachFlow: vi.fn(),
};
vi.mock('../../../features/provisioning/data/flowJourneyLinksRepo', () => ({
    flowJourneyLinksRepo: flowJourneyLinksRepoMock,
}));

/*
 * The service is mocked at the module the route's barrel re-exports, so `runInstall`
 * — which is real here — calls these. That is deliberate: `runInstall` is the shared
 * sequence the Discord button also runs, and stubbing it out would leave the thing
 * these tests most need to observe (that a plan is rebuilt, and that write-back runs
 * after a partial apply) unexercised.
 */
vi.mock('../../../features/provisioning/provisioningService', async (importOriginal) => {
    const actual = await importOriginal<
        typeof import('../../../features/provisioning/provisioningService')
    >();
    return {
        ...actual,
        previewInstall: previewInstallMock,
        installJourney: installJourneyMock,
    };
});

vi.mock('../../../features/provisioning/resourceWriteBack', async (importOriginal) => {
    const actual = await importOriginal<
        typeof import('../../../features/provisioning/resourceWriteBack')
    >();
    return { ...actual, runResourceWriteBack: runResourceWriteBackMock };
});

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

function getPlan() {
    return app().request(`/${GUILD_ID}/flows/${FLOW_ID}/install-plan`);
}

function postInstall(body?: unknown) {
    return app().request(`/${GUILD_ID}/flows/${FLOW_ID}/install`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body ?? {}),
    });
}

/** A journey row as the repo returns it, owned by this flow unless told otherwise. */
function journeyRow(overrides: Record<string, unknown> = {}) {
    return {
        guildId: GUILD_ID,
        journeyKey: FLOW_ID,
        name: 'Test flow',
        description: null,
        createdForFlowId: FLOW_ID,
        resources: [
            { key: 'qa-channel', kind: 'textChannel', defaultName: 'questions' },
        ],
        createdAt: new Date('2026-09-19T10:00:00Z'),
        updatedAt: new Date('2026-09-19T10:00:00Z'),
        ...overrides,
    };
}

function applicablePlan(): InstallPlan {
    return {
        guildId: GUILD_ID,
        journeyKey: FLOW_ID,
        blockers: [],
        items: [
            {
                resourceKey: 'qa-channel',
                kind: 'textChannel',
                action: 'create',
                name: 'questions',
            },
        ],
    };
}

function blockedPlan(): InstallPlan {
    return {
        guildId: GUILD_ID,
        journeyKey: FLOW_ID,
        blockers: [],
        items: [
            {
                resourceKey: 'qa-channel',
                kind: 'textChannel',
                action: 'blocked',
                name: 'questions',
                reason: 'A channel named "questions" already exists.',
            },
        ],
    };
}

const NOTHING_WRITTEN: ResourceWriteBackResult = {
    updatedFlowIds: [],
    writtenCount: 0,
    unresolved: [],
};

interface ErrorBody {
    error: string;
}

interface PlanBody {
    journeyKey: string;
    applicable: boolean;
    blockers: string[];
    items: { resourceKey: string; action: string; name: string; reason?: string }[];
}

interface InstallBody {
    applied: { resourceKey: string; discordId: string }[];
    failure?: string;
    writtenCount: number;
    updatedFlowIds: string[];
    unresolved: string[];
    writeBackFailed: boolean;
}

beforeEach(() => {
    vi.clearAllMocks();
    // Unattached by default: these cases predate the link table and describe a flow
    // resolving its journey by the implicit key rule.
    flowJourneyLinksRepoMock.getJourneyKeyForFlow.mockResolvedValue(null);
    flowJourneyLinksRepoMock.listFlowIdsForJourney.mockResolvedValue([]);
    flowsRepoMock.getByFlowId.mockResolvedValue({
        flowId: FLOW_ID,
        guildId: GUILD_ID,
        name: 'Test',
        enabled: false,
        graph: { version: FLOW_GRAPH_VERSION, nodes: [], edges: [] },
        createdAt: new Date('2026-09-19T10:00:00Z'),
        updatedAt: new Date('2026-09-19T10:00:00Z'),
    });
    journeysRepoMock.getByKey.mockResolvedValue(journeyRow());
    previewInstallMock.mockResolvedValue(applicablePlan());
    installJourneyMock.mockResolvedValue({
        applied: [{ resourceKey: 'qa-channel', discordId: '111', action: 'created', name: 'questions' }],
    } satisfies ApplyInstallPlanResult);
    runResourceWriteBackMock.mockResolvedValue(NOTHING_WRITTEN);
    // Most tests here do not involve a staff-gated journey; the staff describe block
    // below sets this per case.
    guildSettingsRepoMock.getStaffRoleIds.mockResolvedValue([]);
});

describe('the journey must belong to this flow', () => {
    /*
     * A journey key matching a flow id is a convention, not a guarantee: keys are
     * operator-supplied and a standalone journey can have any key at all. Without this
     * guard a URL shaped like a flow provisions channels for a journey that has nothing
     * to do with it, and a stale bookmark is enough to reach it.
     */
    it('refuses to preview a journey created for a different flow', async () => {
        journeysRepoMock.getByKey.mockResolvedValue(
            journeyRow({ createdForFlowId: 'some-other-flow' })
        );

        const response = await getPlan();

        expect(response.status).toBe(409);
        expect(((await response.json()) as ErrorBody).error).toContain('different flow');
        expect(previewInstallMock).not.toHaveBeenCalled();
    });

    it('refuses to install a journey created for a different flow', async () => {
        journeysRepoMock.getByKey.mockResolvedValue(
            journeyRow({ createdForFlowId: 'some-other-flow' })
        );

        const response = await postInstall();

        expect(response.status).toBe(409);
        // The guard is worth nothing if it merely changes the status code.
        expect(installJourneyMock).not.toHaveBeenCalled();
        expect(runResourceWriteBackMock).not.toHaveBeenCalled();
    });

    /*
     * Ownership is checked positively, so a journey with no recorded owner is refused
     * too. `POST /journeys` stores no `createdForFlowId`, and a flow id is a UUID that
     * satisfies the resource-key pattern — so an operator can key a standalone journey
     * on a real flow's id by typing it, not merely by collision. Installing it here
     * would credit this flow with channels it never declared.
     *
     * This is deliberately stricter than `/unpublish`, which accepts a null owner: the
     * teardown shows the exact list first and only deletes what we created, whereas
     * install creates.
     */
    it('refuses a journey with no owning flow recorded, rather than assuming it is ours', async () => {
        journeysRepoMock.getByKey.mockResolvedValue(journeyRow({ createdForFlowId: null }));

        const response = await postInstall();

        expect(response.status).toBe(409);
        const { error } = (await response.json()) as ErrorBody;
        expect(error).toContain('not created by this flow');
        // `/install-journey` is gone, so no refusal may send an operator there —
        // including this one, which is not about staff roles at all.
        expect(error).not.toContain('/install-journey');
        expect(installJourneyMock).not.toHaveBeenCalled();
        expect(runResourceWriteBackMock).not.toHaveBeenCalled();
    });

    it('refuses to preview one with no owning flow recorded, matching the apply', async () => {
        // The preview and the apply must agree about ownership, or one of them is a
        // dead end.
        journeysRepoMock.getByKey.mockResolvedValue(journeyRow({ createdForFlowId: undefined }));

        const response = await getPlan();

        expect(response.status).toBe(409);
        expect(previewInstallMock).not.toHaveBeenCalled();
    });

    /*
     * The other arm, and the only test in this block that exercises it.
     *
     * Every case above runs with no link row, so they all prove the *fallback*. This
     * one proves the rule that replaces it: an attachment an operator wrote is itself
     * the positive evidence the guard asks for, so a journey owned by another flow —
     * or by none — installs when this flow is attached to it. That is the whole point
     * of sharing a journey, and without this test the `!resolved.attached`
     * short-circuit could be inverted or dropped and every suite would stay green.
     *
     * It also pins the key: the install must run against the *journey's* key, not the
     * flow id, or a shared journey provisions nothing.
     */
    it('installs a journey owned by another flow when this flow is attached to it', async () => {
        flowJourneyLinksRepoMock.getJourneyKeyForFlow.mockResolvedValue('shared-onboarding');
        journeysRepoMock.getByKey.mockResolvedValue(
            journeyRow({ journeyKey: 'shared-onboarding', createdForFlowId: 'some-other-flow' })
        );

        const response = await postInstall();

        expect(response.status).toBe(200);
        expect(installJourneyMock).toHaveBeenCalledWith(
            expect.objectContaining({
                journey: expect.objectContaining({ journeyKey: 'shared-onboarding' }),
            })
        );
    });
});

describe('a flow with nothing to install', () => {
    it('404s the plan when the flow declares no resources', async () => {
        journeysRepoMock.getByKey.mockResolvedValue(null);

        const response = await getPlan();

        expect(response.status).toBe(404);
        expect(((await response.json()) as ErrorBody).error).toContain('does not declare');
        expect(previewInstallMock).not.toHaveBeenCalled();
    });

    it('404s the install when the flow declares no resources', async () => {
        journeysRepoMock.getByKey.mockResolvedValue(null);

        const response = await postInstall();

        expect(response.status).toBe(404);
        expect(installJourneyMock).not.toHaveBeenCalled();
    });

    it('404s a flow belonging to another guild without confirming it exists', async () => {
        flowsRepoMock.getByFlowId.mockResolvedValue({
            flowId: FLOW_ID,
            guildId: 'someone-elses-guild',
            name: 'Test',
            enabled: false,
            graph: { version: FLOW_GRAPH_VERSION, nodes: [], edges: [] },
            createdAt: new Date(),
            updatedAt: new Date(),
        });

        const response = await postInstall();

        expect(response.status).toBe(404);
        expect(journeysRepoMock.getByKey).not.toHaveBeenCalled();
    });
});

describe('the plan is rebuilt, never accepted from the browser', () => {
    it('ignores a plan in the request body and applies the one it built', async () => {
        // A plan on the wire is a list of snowflakes a client asked us to mutate.
        const forged: InstallPlan = {
            guildId: GUILD_ID,
            journeyKey: FLOW_ID,
            blockers: [],
            items: [
                {
                    resourceKey: 'qa-channel',
                    kind: 'role',
                    action: 'adopt',
                    name: 'admin',
                    discordId: '999999999999999999',
                },
            ],
        };

        const response = await postInstall({ approvedPlan: forged, plan: forged });

        expect(response.status).toBe(200);
        expect(previewInstallMock).toHaveBeenCalledTimes(1);
        // The applied plan is the rebuilt one, not the body's.
        const applied = installJourneyMock.mock.calls[0][0] as { approvedPlan: InstallPlan };
        expect(applied.approvedPlan).toEqual(applicablePlan());
        expect(applied.approvedPlan.items[0].discordId).toBeUndefined();
    });

    it('refuses to apply when the rebuild is no longer applicable, and returns the new plan', async () => {
        // The guild drifted between the preview the operator read and this press.
        previewInstallMock.mockResolvedValue(blockedPlan());

        const response = await postInstall();

        expect(response.status).toBe(409);
        const body = (await response.json()) as ErrorBody & { plan: PlanBody };
        expect(installJourneyMock).not.toHaveBeenCalled();
        // The rebuilt plan travels with the refusal, so the operator is shown what
        // changed rather than the plan they already agreed to.
        expect(body.plan.applicable).toBe(false);
        expect(body.plan.items[0].reason).toContain('already exists');
    });
});

describe('what an install reports', () => {
    it('runs write-back and reports unresolved keys after a partial apply', async () => {
        // Partial application is a legitimate state: what was created is real and
        // bound, so the ids still have to be written into the flows that picked them.
        installJourneyMock.mockResolvedValue({
            applied: [
                { resourceKey: 'qa-channel', discordId: '111', action: 'created', name: 'questions' },
            ],
            failure: 'Discord refused to create the role: Missing Permissions.',
        } satisfies ApplyInstallPlanResult);
        runResourceWriteBackMock.mockResolvedValue({
            updatedFlowIds: [FLOW_ID],
            writtenCount: 1,
            unresolved: [{ resourceKey: 'staff-role' }, { resourceKey: 'staff-role' }],
        } satisfies ResourceWriteBackResult);

        const response = await postInstall();

        // 200, not an error: what was applied must not be presented as having failed.
        expect(response.status).toBe(200);
        const body = (await response.json()) as InstallBody;

        expect(runResourceWriteBackMock).toHaveBeenCalledWith(expect.anything(), FLOW_ID);
        expect(body.applied).toHaveLength(1);
        expect(body.failure).toContain('Missing Permissions');
        expect(body.writtenCount).toBe(1);
        expect(body.updatedFlowIds).toEqual([FLOW_ID]);
        // Deduplicated: one key picked by several nodes is one thing to fix.
        expect(body.unresolved).toEqual(['staff-role']);
    });

    it('reports a clean install with no failure', async () => {
        const response = await postInstall();
        const body = (await response.json()) as InstallBody;

        expect(response.status).toBe(200);
        expect(body.failure).toBeUndefined();
        expect(body.applied[0].discordId).toBe('111');
        expect(body.writeBackFailed).toBe(false);
        expect(runResourceWriteBackMock).toHaveBeenCalled();
    });

    it('distinguishes a write-back that threw from one with nothing to write', async () => {
        // Both write zero settings. Only one of them means the operator's flows are
        // now pointing at nothing, and a bare count cannot say which happened.
        runResourceWriteBackMock.mockResolvedValue({
            updatedFlowIds: [],
            writtenCount: 0,
            unresolved: [],
            failed: true,
        } satisfies ResourceWriteBackResult);

        const response = await postInstall();
        const body = (await response.json()) as InstallBody;

        // Still 200: the channels were created and must not be reported as lost.
        expect(response.status).toBe(200);
        expect(body.writeBackFailed).toBe(true);
        expect(body.applied).toHaveLength(1);
    });
});

describe('the plan on the wire', () => {
    it('carries every item plus applicability, so the operator sees the whole picture', async () => {
        previewInstallMock.mockResolvedValue({
            guildId: GUILD_ID,
            journeyKey: FLOW_ID,
            blockers: ['The bot lacks **Manage Channels**.'],
            items: [
                { resourceKey: 'qa-channel', kind: 'textChannel', action: 'create', name: 'questions' },
                {
                    resourceKey: 'archive',
                    kind: 'category',
                    action: 'reuse',
                    name: 'Archive',
                    discordId: '222',
                },
            ],
        } satisfies InstallPlan);

        const response = await getPlan();
        const body = (await response.json()) as PlanBody;

        expect(response.status).toBe(200);
        expect(body.applicable).toBe(false);
        expect(body.blockers).toHaveLength(1);
        // Including the item needing no work: "what will this do to my server" is only
        // answerable if the unchanged things are visible too.
        expect(body.items.map((item) => item.action)).toEqual(['create', 'reuse']);
    });

    it('refuses a journey whose permissions name a subject', async () => {
        // A subject is a per-run fact, so these resources cannot be installed as
        // shared guild structure at all — refused before a plan is built, because the
        // blocker's wording would otherwise be about an unresolvable audience.
        journeysRepoMock.getByKey.mockResolvedValue(
            journeyRow({
                resources: [
                    {
                        key: 'qa-channel',
                        kind: 'textChannel',
                        defaultName: 'questions',
                        permissions: [{ audience: 'subject', access: 'readWrite' }],
                    },
                ],
            })
        );

        const response = await getPlan();

        expect(response.status).toBe(409);
        expect(((await response.json()) as ErrorBody).error).toContain('subject');
        expect(previewInstallMock).not.toHaveBeenCalled();
    });

});

/**
 * Staff roles come from guild settings, not from the request.
 *
 * The refusal is conditional now: a staff-gated journey installs fine once the
 * operator has configured staff roles, and is refused only when they have not. That
 * is the whole point of the settings surface — previously this was refused outright
 * with a pointer at `/install-journey`.
 */
describe('a journey that grants access to staff', () => {
    const STAFF_ROLE = '333333333333333333';

    function staffGatedJourney() {
        return journeyRow({
            resources: [
                {
                    key: 'qa-channel',
                    kind: 'textChannel',
                    defaultName: 'questions',
                    permissions: [{ audience: 'staff', access: 'readWrite' }],
                },
            ],
        });
    }

    beforeEach(() => {
        journeysRepoMock.getByKey.mockResolvedValue(staffGatedJourney());
    });

    it('installs once the guild has staff roles configured', async () => {
        guildSettingsRepoMock.getStaffRoleIds.mockResolvedValue([STAFF_ROLE]);

        const response = await postInstall();

        expect(response.status).toBe(200);
        expect(installJourneyMock).toHaveBeenCalled();
    });

    it('compiles the install against the configured roles, not an empty list', async () => {
        // The bug this guards: passing `[]` through would create a staff-only channel
        // that no staff role can see, and it would look like a successful install.
        guildSettingsRepoMock.getStaffRoleIds.mockResolvedValue([STAFF_ROLE]);

        await postInstall();

        const call = previewInstallMock.mock.calls[0][0] as { staffRoleIds: string[] };
        expect(call.staffRoleIds).toEqual([STAFF_ROLE]);
    });

    it('previews against the configured roles too, so the plan matches the apply', async () => {
        guildSettingsRepoMock.getStaffRoleIds.mockResolvedValue([STAFF_ROLE]);

        const response = await getPlan();

        expect(response.status).toBe(200);
        const call = previewInstallMock.mock.calls[0][0] as { staffRoleIds: string[] };
        expect(call.staffRoleIds).toEqual([STAFF_ROLE]);
    });

    it('still refuses to install when no staff roles are configured', async () => {
        guildSettingsRepoMock.getStaffRoleIds.mockResolvedValue([]);

        const response = await postInstall();

        expect(response.status).toBe(409);
        expect(installJourneyMock).not.toHaveBeenCalled();
    });

    it('points the operator at the settings page rather than the retired command', async () => {
        // `/install-journey` has been deleted, so naming it here would send the
        // operator somewhere that no longer exists.
        guildSettingsRepoMock.getStaffRoleIds.mockResolvedValue([]);

        const error = ((await (await postInstall()).json()) as ErrorBody).error;

        expect(error).toContain('Server Settings');
        expect(error).not.toContain('/install-journey');
    });

    it('refuses the preview on the same terms as the apply', async () => {
        guildSettingsRepoMock.getStaffRoleIds.mockResolvedValue([]);

        const response = await getPlan();

        expect(response.status).toBe(409);
        expect(previewInstallMock).not.toHaveBeenCalled();
    });
});

describe('a journey naming a subject', () => {
    beforeEach(() => {
        journeysRepoMock.getByKey.mockResolvedValue(
            journeyRow({
                resources: [
                    {
                        key: 'qa-channel',
                        kind: 'textChannel',
                        defaultName: 'questions',
                        permissions: [{ audience: 'subject', access: 'readWrite' }],
                    },
                ],
            })
        );
    });

    it('is refused even when staff roles are configured, because a subject is per-run', async () => {
        // The subject refusal is permanent and unrelated to configuration: no amount
        // of settings creates a member at install time.
        guildSettingsRepoMock.getStaffRoleIds.mockResolvedValue(['333333333333333333']);

        const response = await postInstall();

        expect(response.status).toBe(409);
        expect(((await response.json()) as ErrorBody).error).toContain('subject');
        expect(installJourneyMock).not.toHaveBeenCalled();
    });

    it('does not send the operator after a retired command', async () => {
        const error = ((await (await getPlan()).json()) as ErrorBody).error;

        expect(error).not.toContain('/install-journey');
        expect(error).not.toContain('staff-role');
    });
});
