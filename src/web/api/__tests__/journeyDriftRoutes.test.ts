import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ResourceBindingsRepo } from '../../../features/provisioning/data/resourceBindingsRepo';
import type { JourneysRepo } from '../../../features/provisioning/data/journeysRepo';
import type { JourneyEntity } from '../../../features/provisioning/data/journeysSchema';
import type { AppEnv } from '../../types';

/**
 * The journey-scoped drift routes: `GET /journeys/:journeyKey/drift`,
 * `POST .../repair` and `POST .../orphans/:bindingId/forget`.
 *
 * These are the surface that makes drift reachable at all. The engine could already
 * answer every question below and no operator could ask one, which is the gap commit
 * `1a094e8` recorded.
 *
 * What these tests own is the **route's** behaviour, not the engine's: which key it
 * asks about, what it refuses, and — the two that matter most — that repair rebuilds
 * its own plan rather than accepting one from the browser, and that forgetting a
 * record requires the record to still be an orphan. Whether a rename is detected, or
 * an adopted resource withheld from repair, is settled in provisioning's own suites
 * and driving it again through HTTP would test the engine twice and the route once.
 */

const journeysRepoMock = {
    listByGuildId: vi.fn(),
    getByKey: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    deleteByKey: vi.fn(),
} satisfies Record<
    keyof Pick<JourneysRepo, 'listByGuildId' | 'getByKey' | 'create' | 'update' | 'deleteByKey'>,
    unknown
>;

class DuplicateJourneyKeyError extends Error {}

/**
 * `toDeclarationFromRow` is imported by the route from this module and is a pure
 * mapper, so the real one is kept rather than stubbed — a fake would let the route
 * pass a shape the engine never receives in production.
 */
vi.mock('../../../features/provisioning/data/journeysRepo', async (importOriginal) => {
    const actual =
        await importOriginal<typeof import('../../../features/provisioning/data/journeysRepo')>();
    return {
        ...actual,
        journeysRepo: journeysRepoMock,
        DuplicateJourneyKeyError,
    };
});

const linksRepo = {
    getJourneyKeyForFlow: vi.fn(),
    listFlowIdsForJourney: vi.fn(),
    listLinksForGuild: vi.fn(),
    attach: vi.fn(),
    detachFlow: vi.fn(),
};

vi.mock('../../../features/provisioning/data/flowJourneyLinksRepo', () => ({
    flowJourneyLinksRepo: linksRepo,
}));

const flowsRepoMock = { getByFlowId: vi.fn(), getByGuildId: vi.fn() };
vi.mock('../../../features/flows/data/flowsRepo', () => ({ flowsRepo: flowsRepoMock }));

/** The row-level cleanup the forget route performs, and the only write it makes. */
const bindingsRepo = {
    forget: vi.fn(),
} satisfies Record<keyof Pick<ResourceBindingsRepo, 'forget'>, unknown>;

vi.mock('../../../features/provisioning/data/resourceBindingsRepo', () => ({
    resourceBindingsRepo: bindingsRepo,
}));

const guildSettingsRepoMock = { getStaffRoleIds: vi.fn() };
vi.mock('../../../features-system/guild-settings', () => ({
    guildSettingsRepo: guildSettingsRepoMock,
}));

/**
 * The drift engine, stubbed at the service boundary for the reason the teardown
 * routes' tests state: these assertions are about whether the route reaches it and
 * what it does with the answer, not about plan arithmetic.
 */
const previewDriftMock = vi.fn();
const previewOrphansMock = vi.fn();
const repairDriftMock = vi.fn();

vi.mock('../../../features/provisioning', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../../features/provisioning')>();
    return {
        ...actual,
        previewDrift: previewDriftMock,
        previewOrphans: previewOrphansMock,
        repairDrift: repairDriftMock,
    };
});

vi.mock('../../../features/flows/logic/undeployFlowButtons', () => ({
    undeployFlowButtons: vi.fn(),
}));

const { journeyRoutes, repairBody } = await import('../journeyRoutes');

const GUILD_ID = 'guild-1';
const OTHER_GUILD = 'guild-2';
const JOURNEY_KEY = 'onboarding';
/** A snowflake that appears only in a plan the browser invented. */
const FORGED_ID = '999999999999999999';

function journeyRow(overrides: Partial<JourneyEntity> = {}): JourneyEntity {
    return {
        id: 1,
        journeyKey: JOURNEY_KEY,
        guildId: GUILD_ID,
        name: 'Onboarding',
        description: null,
        createdForFlowId: null,
        resources: [{ key: 'qa-channel', kind: 'textChannel', defaultName: 'questions' }],
        createdAt: new Date('2026-09-24T10:00:00Z'),
        updatedAt: new Date('2026-09-24T10:00:00Z'),
        ...overrides,
    };
}

function driftReport(overrides: Record<string, unknown> = {}) {
    return {
        bindingId: 7,
        resourceKey: 'qa-channel',
        name: 'questions',
        kind: 'textChannel' as const,
        discordId: '111111111111111111',
        drift: [{ kind: 'renamed' as const, declared: 'questions', actual: 'general-chat' }],
        repairable: true,
        ...overrides,
    };
}

function orphan(overrides: Record<string, unknown> = {}) {
    return {
        bindingId: 42,
        resourceKey: 'old-channel',
        kind: 'textChannel' as const,
        name: 'archive',
        discordId: '222222222222222222',
        stillInGuild: true,
        mayDelete: true,
        neverSettled: false,
        ...overrides,
    };
}

function emptyPlan(overrides: Record<string, unknown> = {}) {
    return {
        guildId: GUILD_ID,
        journeyKey: JOURNEY_KEY,
        drifted: [],
        cleanKeys: [],
        unchecked: [],
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

function getDrift(journeyKey: string = JOURNEY_KEY) {
    return app().request(`/${GUILD_ID}/journeys/${journeyKey}/drift`);
}

function postRepair(body: unknown, journeyKey: string = JOURNEY_KEY) {
    return app().request(`/${GUILD_ID}/journeys/${journeyKey}/repair`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
    });
}

function postForget(bindingId: number | string, journeyKey: string = JOURNEY_KEY) {
    return app().request(
        `/${GUILD_ID}/journeys/${journeyKey}/orphans/${bindingId}/forget`,
        { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }
    );
}

/*
 * `Response.json()` is typed `unknown`, so every read needs a shape.
 *
 * Two helpers rather than a cast per call site: the cast is a claim about the wire, and
 * stating it in one place means a route that changes its response breaks here rather
 * than in whichever assertion happened to read the changed field first. The shapes are
 * deliberately loose — this file asserts route *behaviour*, and `driftWireShapeDrift`
 * is what holds the field names to `driftBody.ts`.
 */
async function readJson<T>(response: Response): Promise<T> {
    return (await response.json()) as T;
}

interface DriftResponse {
    readonly drifted: readonly {
        readonly resourceKey: string;
        readonly kind: string;
        readonly repairable: boolean;
        readonly drift: readonly { readonly kind: string; readonly explanation: string }[];
    }[];
    readonly cleanKeys: readonly string[];
    readonly unchecked: readonly { readonly resourceKey: string }[];
    readonly orphans: readonly { readonly bindingId: number }[];
}

/** Guild-scoped, so a key belonging to another guild genuinely answers nothing. */
function journeyExists(rows: readonly JourneyEntity[]): void {
    journeysRepoMock.getByKey.mockImplementation(
        async (guildId: string, journeyKey: string) =>
            rows.find((row) => row.guildId === guildId && row.journeyKey === journeyKey) ?? null
    );
}

beforeEach(() => {
    vi.clearAllMocks();
    journeyExists([journeyRow()]);
    guildSettingsRepoMock.getStaffRoleIds.mockResolvedValue([]);
    previewDriftMock.mockResolvedValue(emptyPlan());
    previewOrphansMock.mockResolvedValue([]);
    repairDriftMock.mockResolvedValue({ results: [] });
    bindingsRepo.forget.mockResolvedValue(true);
});

describe('GET /journeys/:journeyKey/drift', () => {
    it('reports drift and orphans together in one response', async () => {
        previewDriftMock.mockResolvedValue(
            emptyPlan({ drifted: [driftReport()], cleanKeys: ['welcome'] })
        );
        previewOrphansMock.mockResolvedValue([orphan()]);

        const response = await getDrift();
        expect(response.status).toBe(200);

        const body = await readJson<DriftResponse>(response);
        expect(body.drifted).toHaveLength(1);
        expect(body.orphans).toHaveLength(1);
        // Both questions on one screen is the point: an operator asking "is my server
        // still what I asked for" must not get half the answer.
        expect(body.cleanKeys).toEqual(['welcome']);
    });

    it('carries one explanation per drift rather than collapsing them', async () => {
        previewDriftMock.mockResolvedValue(
            emptyPlan({
                drifted: [
                    driftReport({
                        drift: [
                            { kind: 'renamed', declared: 'questions', actual: 'general-chat' },
                            { kind: 'reparented', declaredParentId: '333', actualParentId: null },
                        ],
                    }),
                ],
            })
        );

        const body = await readJson<DriftResponse>(await getDrift());
        expect(body.drifted[0].drift).toHaveLength(2);
        expect(body.drifted[0].drift[0].kind).toBe('renamed');
        expect(body.drifted[0].drift[0].explanation).toContain('general-chat');
        expect(body.drifted[0].drift[1].kind).toBe('reparented');
        // Two findings, two sentences. Joining them would lose the ability to show
        // them as the separate things they are.
        expect(body.drifted[0].drift[1].explanation).not.toEqual(
            body.drifted[0].drift[0].explanation
        );
    });

    it('passes the engine repairable through rather than re-deriving it', async () => {
        // An adopted resource drifts and is reported, but repair is withheld. Nothing
        // in `drift` says so — adoption is a property of the binding — so a client
        // inferring repairability from the kinds would offer a repair the server
        // refuses.
        previewDriftMock.mockResolvedValue(
            emptyPlan({ drifted: [driftReport({ repairable: false })] })
        );

        const body = await readJson<DriftResponse>(await getDrift());
        expect(body.drifted[0].repairable).toBe(false);
    });

    it('reports resources whose permissions could not be checked as neither clean nor drifted', async () => {
        previewDriftMock.mockResolvedValue(
            emptyPlan({
                unchecked: [
                    { resourceKey: 'dm-channel', name: 'private', reason: 'Names a subject.' },
                ],
            })
        );

        const body = await readJson<DriftResponse>(await getDrift());
        expect(body.unchecked).toHaveLength(1);
        expect(body.cleanKeys).toEqual([]);
        expect(body.drifted).toEqual([]);
    });

    it('reads the guild staff roles so the comparison compiles what an install would', async () => {
        guildSettingsRepoMock.getStaffRoleIds.mockResolvedValue(['444444444444444444']);

        await getDrift();

        expect(previewDriftMock).toHaveBeenCalledWith(
            expect.objectContaining({ staffRoleIds: ['444444444444444444'] })
        );
    });

    it('404s a journey from another guild without confirming it exists', async () => {
        journeyExists([journeyRow({ guildId: OTHER_GUILD, journeyKey: 'theirs' })]);

        const response = await getDrift('theirs');

        expect(response.status).toBe(404);
        expect(previewDriftMock).not.toHaveBeenCalled();
    });
});

describe('POST /journeys/:journeyKey/repair', () => {
    /*
     * ## What actually enforces this, and where the test therefore points
     *
     * The guarantee is that a plan named by the browser can never reach the applier.
     * It is enforced **at the schema**, not by the handler: `repairBody` does not
     * declare `approvedPlan`, and `zod` strips unknown keys, so `parsed.data` cannot
     * carry one however the handler is later written.
     *
     * That is worth stating because the obvious test does not test it. An earlier
     * version sent a forged `approvedPlan` and asserted the rebuilt one came back — and
     * it **passed against a handler deliberately rewritten to prefer the browser's
     * plan**, because the forged key had already been stripped before the handler ran.
     * It could not fail, whatever the handler did.
     *
     * So this asserts both halves: the applier receives the rebuilt plan, *and* the
     * parse discards a forged one. The second is the load-bearing claim, and it is
     * checked against `repairBody` directly so that widening the schema — the one edit
     * that would genuinely break this — fails here.
     */
    it('rebuilds the plan server-side rather than accepting one from the browser', async () => {
        const rebuilt = emptyPlan({ drifted: [driftReport()] });
        previewDriftMock.mockResolvedValue(rebuilt);

        const forged = emptyPlan({
            drifted: [driftReport({ name: 'not-the-real-channel', discordId: FORGED_ID })],
        });

        await postRepair({ resourceKeys: ['qa-channel'], approvedPlan: forged });

        expect(previewDriftMock).toHaveBeenCalled();

        const [input] = repairDriftMock.mock.calls[0];
        expect(input.approvedPlan).toEqual(rebuilt);
        // The specific harm: a snowflake the browser named, which the real report never
        // mentioned, must never reach the applier.
        expect(JSON.stringify(input.approvedPlan)).not.toContain(FORGED_ID);
    });

    it('discards a plan sent in the body at the schema, whatever the handler does with it', async () => {
        const parsed = repairBody.safeParse({
            resourceKeys: ['qa-channel'],
            approvedPlan: emptyPlan({ drifted: [driftReport({ discordId: FORGED_ID })] }),
        });

        expect(parsed.success).toBe(true);
        // Not merely "the handler ignores it" — it is not there to be honoured.
        expect(parsed.data).toEqual({ resourceKeys: ['qa-channel'] });
        expect('approvedPlan' in (parsed.data ?? {})).toBe(false);
    });

    it('acts only on the keys the operator ticked', async () => {
        await postRepair({ resourceKeys: ['qa-channel'] });

        const [input] = repairDriftMock.mock.calls[0];
        expect(input.approvedKeys).toEqual(new Set(['qa-channel']));
    });

    it('rejects an empty selection rather than reporting nothing repaired', async () => {
        const response = await postRepair({ resourceKeys: [] });

        expect(response.status).toBe(400);
        expect(repairDriftMock).not.toHaveBeenCalled();
    });

    it('rejects a malformed body', async () => {
        const response = await postRepair({ keys: ['qa-channel'] });

        expect(response.status).toBe(400);
        expect(repairDriftMock).not.toHaveBeenCalled();
    });

    it('re-reads staff roles at apply time rather than trusting the preview', async () => {
        guildSettingsRepoMock.getStaffRoleIds.mockResolvedValue(['555555555555555555']);

        await postRepair({ resourceKeys: ['qa-channel'] });

        expect(repairDriftMock).toHaveBeenCalledWith(
            expect.objectContaining({ staffRoleIds: ['555555555555555555'] })
        );
    });

    it('returns a refusal as 409', async () => {
        repairDriftMock.mockResolvedValue({ results: [], refusal: 'Wrong guild.' });

        const response = await postRepair({ resourceKeys: ['qa-channel'] });

        expect(response.status).toBe(409);
        expect((await readJson<{ error: string }>(response)).error).toBe('Wrong guild.');
    });

    it('reports a partial repair as 200, because what was fixed is really fixed', async () => {
        repairDriftMock.mockResolvedValue({
            results: [
                { resourceKey: 'qa-channel', name: 'questions', outcome: 'repaired', repaired: ['renamed'] },
                { resourceKey: 'welcome', name: 'welcome', outcome: 'failed', explanation: 'Discord refused.' },
            ],
        });

        const response = await postRepair({ resourceKeys: ['qa-channel', 'welcome'] });

        expect(response.status).toBe(200);
        expect((await readJson<{ results: unknown[] }>(response)).results).toHaveLength(2);
    });

    it('404s a journey from another guild without repairing anything', async () => {
        journeyExists([journeyRow({ guildId: OTHER_GUILD, journeyKey: 'theirs' })]);

        const response = await postRepair({ resourceKeys: ['qa-channel'] }, 'theirs');

        expect(response.status).toBe(404);
        expect(repairDriftMock).not.toHaveBeenCalled();
    });
});

describe('POST /journeys/:journeyKey/orphans/:bindingId/forget', () => {
    it('forgets the record and says the object is still there', async () => {
        previewOrphansMock.mockResolvedValue([orphan()]);

        const response = await postForget(42);

        expect(response.status).toBe(200);
        expect(bindingsRepo.forget).toHaveBeenCalledWith(42);

        const body = await readJson<{ forgotten: boolean; objectRemains: boolean; name: string }>(response);
        expect(body.forgotten).toBe(true);
        // The distinction the operator is owed: something is still sitting in their
        // server that nothing tracks any more.
        expect(body.objectRemains).toBe(true);
        expect(body.name).toBe('archive');
    });

    it('says the object is gone when only the record was left', async () => {
        previewOrphansMock.mockResolvedValue([orphan({ stillInGuild: false })]);

        const body = await readJson<{ objectRemains: boolean }>(await postForget(42));

        expect(body.objectRemains).toBe(false);
    });

    it('refuses a binding that is not an orphan, so a still-declared row survives', async () => {
        // The one row whose disappearance genuinely breaks things: install would then
        // create a second copy of a resource that already exists.
        previewOrphansMock.mockResolvedValue([]);

        const response = await postForget(7);

        expect(response.status).toBe(404);
        expect(bindingsRepo.forget).not.toHaveBeenCalled();
    });

    it('refuses an orphan belonging to a different journey', async () => {
        previewOrphansMock.mockResolvedValue([orphan({ bindingId: 42 })]);

        const response = await postForget(999);

        expect(response.status).toBe(404);
        expect(bindingsRepo.forget).not.toHaveBeenCalled();
    });

    it('rejects a non-numeric binding id', async () => {
        const response = await postForget('not-a-number');

        expect(response.status).toBe(400);
        expect(bindingsRepo.forget).not.toHaveBeenCalled();
    });

    it('404s a journey from another guild without touching any record', async () => {
        journeyExists([journeyRow({ guildId: OTHER_GUILD, journeyKey: 'theirs' })]);

        const response = await postForget(42, 'theirs');

        expect(response.status).toBe(404);
        expect(previewOrphansMock).not.toHaveBeenCalled();
        expect(bindingsRepo.forget).not.toHaveBeenCalled();
    });

    it('reports a record that vanished between the report and the press', async () => {
        previewOrphansMock.mockResolvedValue([orphan()]);
        bindingsRepo.forget.mockResolvedValue(false);

        const response = await postForget(42);

        expect(response.status).toBe(404);
    });
});
