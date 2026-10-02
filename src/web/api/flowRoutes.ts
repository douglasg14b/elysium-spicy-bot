import { Hono } from 'hono';
import { z } from 'zod';
import { flowGraphSchema, FLOW_GRAPH_VERSION, type FlowGraph } from '../../features/flows/data/flowGraph';
import { flowsRepo, type FlowWriteDecision } from '../../features/flows/data/flowsRepo';
import type { FlowEntity } from '../../features/flows/data/flowsSchema';
import { validateFlowGraph } from '../../features/flows/engine/graphValidation';
import type { FlowValidationIssue } from '../../features/flows/engine/nodeDataValidation';
import { readDeclaredKeys } from '../../features/flows/logic/declaredResourceKeys';
import { deployFlowButtons } from '../../features/flows/logic/deployFlowButtons';
import {
    flowReadinessIssues,
    installBeforeEnablingMessage,
    problemCount,
    uninstalledResourceKeys,
} from '../../features/flows/logic/flowReadiness';
import { getPublishedFlowState } from '../../features/flows/logic/publishedFlowState';
import { undeployFlowButtons } from '../../features/flows/logic/undeployFlowButtons';
import { guildSettingsRepo } from '../../features-system/guild-settings';
import {
    flowDetail,
    flowDraft,
    flowDraftBaseSchema,
    flowNameSchema,
    flowSummary,
    invalidGraphBody,
    type FlowSaveBody,
} from './flowBody';
import { flowDraftRoutes } from './flowDraftRoutes';
import { loadFlowJourneyIndex } from './flowJourneyIndex';
import { toDeclarationFromRow } from '../../features/provisioning/data/journeysRepo';
import { resolveFlowJourney } from '../../features/provisioning/logic/resolveFlowJourney';
import {
    otherFlowsOnJourney,
    sharedJourneyRefusal,
} from '../../features/provisioning/logic/sharedJourneyGuard';
import {
    isPlanApplicable,
    journeyBusyMessage,
    journeyNeedsStaffRoles,
    journeyNeedsSubject,
    previewInstall,
    previewUnpublish,
    runInstall,
    unpublishJourney,
    type InstallPlan,
    type JourneyDeclaration,
} from '../../features/provisioning';
import type { AppEnv } from '../types';
import { flowNameInGuild } from './flowNameInGuild';
import { publishedBody } from './publishedBody';

/**
 * Flow CRUD + deploy for the Phase 4 builder. Mounted under the `/api/guilds` route
 * group, which applies `requireAuth` and then `requireGuildAccess` — so by the time a
 * handler runs, the caller is authorized for the guild and `c.get('guild')` is the
 * resolved, bot-present guild. See design doc §5.3 / §5.5.
 */

const createFlowBody = z.object({
    name: flowNameSchema,
    graph: flowGraphSchema.optional(),
});

const updateFlowBody = z.object({
    name: flowNameSchema.optional(),
    enabled: z.boolean().optional(),
    graph: flowGraphSchema.optional(),
    baseUpdatedAt: flowDraftBaseSchema.optional(),
});

const checkFlowBody = z.object({
    graph: flowGraphSchema,
});

/** Why a PUT was refused before it could go live: the `{ error, issues }` body of a 400. */
interface ReadinessRefusal {
    readonly error: string;
    /** Empty for the install refusal, where nothing on the canvas is wrong. */
    readonly issues: readonly FlowValidationIssue[];
}

/** A PUT's parsed body, graph already through the structural check. */
interface FlowPutRequest {
    readonly name?: string;
    readonly enabled?: boolean;
    readonly graph?: FlowGraph;
    /**
     * The flow version the sent graph was edited from, consulted only if the save lands
     * as a draft. A caller that does not say is taken to have edited the flow as it is
     * now — the same answer the draft routes would get from a page that just loaded it.
     */
    readonly baseUpdatedAt?: string;
}

/** Who is saving — the draft a live flow's incomplete save lands on is theirs. */
interface FlowSaver {
    readonly id: string;
    readonly name: string;
}

/**
 * Where a PUT lands on the flow as it is **now**: the flow row, the saver's draft, or
 * nowhere.
 *
 * Handed to `flowsRepo.mutate`, which calls it with the row inside the write's own
 * transaction — so "is this flow live" and "is its stored graph ready" are answered
 * about the row being written, not about a copy an earlier read happened to see.
 * Synchronous, and closed over everything it needs from elsewhere, for the deadlock
 * reason `mutate` gives.
 *
 * In this order:
 *
 *  - **A live flow's incomplete graph goes to the saver's draft** and the flow row is
 *    not touched — not its graph, not its name. Storing it would put a half-finished
 *    canvas in front of every member who presses its button; refusing it would throw
 *    the work back. "Live" means live now and staying on: a request that switches the
 *    flow off in the same breath is judged as the off flow it leaves behind. A graph
 *    that is complete but **waiting on its install** goes the same way, for the reason
 *    the switch-on below refuses one: a live flow would run members into the empty id.
 *    That matters more with drafts about, because install writes its ids into the flow
 *    and never into a draft — so a draft started before an install still has holes.
 *  - **An incomplete flow cannot be switched on** (400), judged against the graph it
 *    would run — the one arriving with the request, or the stored one. This also
 *    catches an off flow sent an incomplete graph and `enabled: true` together, which
 *    is a switch-on, not a live flow's edit, and gets that sentence.
 *  - **A flow waiting on its install cannot be switched on** (400) — an off → on
 *    switch only, so re-sending `enabled: true` to a flow already live is not suddenly
 *    refused. Ready is about the canvas and says nothing about the guild; see
 *    `uninstalledResourceKeys` for why this is its own check with its own sentence.
 *  - Otherwise the row is written, and a graph arriving supersedes the saver's draft.
 *
 * `declaredKeys` is `null` exactly when the request could not have been refused — no
 * graph and no switch-on — because the caller reads the declarations only when they
 * can decide something.
 */
function decidePut(
    current: FlowEntity,
    request: FlowPutRequest,
    saver: FlowSaver,
    declaredKeys: ReadonlySet<string> | null
): FlowWriteDecision<ReadinessRefusal> {
    if (declaredKeys) {
        const runs = request.graph ?? current.graph;
        const issues = flowReadinessIssues(runs, declaredKeys);
        const staysLive = current.enabled && request.enabled !== false;

        if (
            request.graph !== undefined &&
            staysLive &&
            (issues.length > 0 || uninstalledResourceKeys(request.graph, declaredKeys).length > 0)
        ) {
            return {
                kind: 'draft',
                draft: {
                    authorId: saver.id,
                    authorName: saver.name,
                    name: request.name ?? current.name,
                    graph: request.graph,
                    baseUpdatedAt: request.baseUpdatedAt ?? new Date(current.updatedAt).toISOString(),
                },
            };
        }
        if (issues.length > 0 && request.enabled === true) {
            return {
                kind: 'refuse',
                refusal: { error: `Fix ${problemCount(issues.length)} before turning this flow on.`, issues },
            };
        }
        if (request.enabled === true && !current.enabled) {
            const waiting = uninstalledResourceKeys(runs, declaredKeys);
            if (waiting.length > 0) {
                return { kind: 'refuse', refusal: { error: installBeforeEnablingMessage(waiting), issues: [] } };
            }
        }
    }

    return {
        kind: 'write',
        input: { name: request.name, enabled: request.enabled, graph: request.graph },
        // Only a graph is the saver's canvas landing. A rename or a toggle — the list's
        // switch included — leaves a draft they are still working on where it is.
        discardDraftOf: request.graph !== undefined ? saver.id : undefined,
    };
}

/**
 * The journey a flow installs, or the reason this flow may not install it.
 *
 * **The journey must say it belongs to this flow.** A journey key matching a flow id
 * is a convention, not a guarantee: keys are operator-supplied, and `POST /journeys`
 * stores no `createdForFlowId` at all, so a standalone journey can carry any key —
 * including one that happens to match a real flow's id. A flow id is a UUID, which
 * satisfies the resource-key pattern, so this is reachable by typing rather than only
 * by collision.
 *
 * Hence ownership is checked **positively**, not by ruling out a conflicting owner.
 * The weaker `createdForFlowId && createdForFlowId !== flowId` test — which is what
 * `/unpublish` uses — lets a null-owner journey through, which is precisely the case
 * the paragraph above describes. That is survivable for teardown, where the operator
 * is shown the exact list before anything is destroyed and the objects were ones we
 * created anyway; it is not survivable for install, which *creates* channels and roles
 * and would attribute them to a flow that never declared them. The flow's resource
 * panel writes `createdForFlowId` on first save, so every flow-owned journey has it.
 *
 * **A link row is that positive evidence, and it is stronger than the owner column
 * was.** An attachment is data an operator deliberately wrote, not a key that happens
 * to look like a flow id, so `attached` alone settles the question — and it has to,
 * because a journey shared by several flows has no single `createdForFlowId` to match.
 * This is the check getting stricter, not looser: the unlinked path below still
 * demands the old positive owner match, so a typed-key collision is refused exactly as
 * it was before.
 *
 * ---
 *
 * **Re-examined in slice D, when attach stopped being flow-save-only.** Until D the
 * sole writer of a link row was this flow's own `PUT /flows/:flowId/resources`, so
 * `attached` meant "this flow declared these resources itself" — unambiguous positive
 * ownership. `POST /flows/:flowId/attach` now writes link rows from an operator-supplied
 * journey key, and the question is whether that degrades `attached` into the weaker
 * "no conflicting owner" test this comment spends two paragraphs rejecting.
 *
 * It does not, because **the attach route is the trust boundary** and it is a strictly
 * narrower gate than the collision this guard was written for. Three properties make a
 * link row still a deliberate declaration rather than a typed key:
 *
 *  1. **The journey must already exist as a row in this guild.** Attach resolves it with
 *     `journeysRepo.getByKey(guildId, key)` and 404s otherwise, so a key cannot be
 *     conjured. The hazard the paragraphs above describe is a *journey that was never
 *     this flow's* being reached through a **URL** — `/flows/<uuid>/install`, where the
 *     uuid satisfies the resource-key pattern. That path writes nothing and is still
 *     refused by the unlinked arm below.
 *  2. **Both sides are guild-scoped and checked**, so attaching can never cross a guild
 *     in either direction.
 *  3. **It is an act, not a coincidence.** `attached` is only ever true because someone
 *     with guild access named this flow and this journey together in one request. That
 *     is the operator saying "this flow installs that journey" — which is exactly the
 *     declaration `createdForFlowId` recorded for the implicit case, said out loud for
 *     the shared one.
 *
 * The rejected alternative was to let `attached` suppress the owner check **only** when
 * the journey is genuinely shared (null `createdForFlowId` *and* more than one attached
 * flow). It refuses the slice's own bar: an operator creates a journey via
 * `POST /journeys` (which records no owner), attaches their first flow, and installs —
 * one attached flow, null owner, and that rule refuses it. It would also make install
 * succeed or fail depending on how many *other* flows are attached, so detaching a
 * second flow would silently revoke the first's ability to install. Ownership must not
 * be a function of someone else's attachment.
 *
 * Shared by the preview and the apply so the two cannot disagree about which journeys
 * this flow owns. A preview an operator is allowed to see but not apply would be a
 * dead end, and the reverse would be worse.
 */
type FlowJourneyLookup =
    | { readonly ok: true; readonly journey: JourneyDeclaration }
    | { readonly ok: false; readonly error: string; readonly status: 404 | 409 };

async function flowJourney(guildId: string, flowId: string): Promise<FlowJourneyLookup> {
    const resolved = await resolveFlowJourney(guildId, flowId);
    if (!resolved) {
        return {
            ok: false,
            status: 404,
            error: 'This flow does not declare any channels or roles to install.',
        };
    }

    const row = resolved.journey;
    // The attachment is the positive evidence, and it stays that way now that
    // `POST /attach` can write one: that route resolves the journey row in this guild
    // before linking, so a link means an operator named this flow and an existing
    // journey together — not that a key was typed at a URL. See the header, which
    // records why this was re-examined in slice D and why the stricter
    // "shared-journeys-only" variant was rejected.
    //
    // Only the temporary unlinked path has to fall back on the key convention, and
    // there the owner column must still match.
    if (!resolved.attached && row.createdForFlowId !== flowId) {
        return {
            ok: false,
            status: 409,
            error: row.createdForFlowId
                ? 'That journey belongs to a different flow. Install it from there, so you can see what it will create.'
                : 'A journey with this key exists but was not created by this flow, so installing it here would credit this flow with channels it never declared.',
        };
    }

    return { ok: true, journey: toDeclarationFromRow(row) };
}

/**
 * Why a journey cannot be installed as shared guild structure, if it cannot.
 *
 * Two questions, and they are genuinely different in kind:
 *
 *  - A **subject** is a per-run fact — the specific member a resource is about. It
 *    does not exist at install time and no amount of configuration creates one, so
 *    this refusal is permanent and has no action attached to it.
 *  - **Staff roles** are an ordinary guild fact, now read from guild settings. The
 *    refusal is therefore conditional and fixable: it fires only when the journey
 *    grants staff access and the operator has configured no staff roles, and it
 *    points at the settings page that fixes it.
 *
 * Both asked before the plan is built, because these compile to blockers whose
 * wording is about an unresolvable audience rather than about the declaration being
 * the wrong shape for installing at all.
 *
 * Installing a staff-gated journey with an empty staff list is what this prevents:
 * it would create a staff-only channel that no staff role can see.
 */
function journeyInstallRefusal(
    journey: JourneyDeclaration,
    staffRoleIds: readonly string[]
): string | undefined {
    if (journeyNeedsSubject(journey)) {
        return (
            'This flow declares a resource whose permissions name a subject — the specific ' +
            'member it is about. A subject only exists while a flow runs, so these resources ' +
            'cannot be installed as shared server structure.'
        );
    }
    if (journeyNeedsStaffRoles(journey) && staffRoleIds.length === 0) {
        return (
            'This flow grants access to staff, but no staff roles are configured for this ' +
            'server — so the install would create a staff-only channel that nobody can see. ' +
            'Set them under Configure › Server Settings, then try again.'
        );
    }

    return undefined;
}

/**
 * The wire shape for an install plan.
 *
 * Every item, including the ones needing no work: "what will this do to my server" is
 * only answerable if the unchanged things are visible too. `reason` carries both the
 * blocker's explanation and the note on a create that replaces something deleted, so a
 * client shows it without asking which kind it is.
 */
function installPlanBody(plan: InstallPlan) {
    return {
        journeyKey: plan.journeyKey,
        applicable: isPlanApplicable(plan),
        blockers: plan.blockers,
        items: plan.items.map((item) => ({
            resourceKey: item.resourceKey,
            kind: item.kind,
            action: item.action,
            name: item.name,
            discordId: item.discordId,
            reason: item.reason,
        })),
    };
}

export function flowRoutes(): Hono<AppEnv> {
    const app = new Hono<AppEnv>();

    // Drafts live under each flow's URL, and every surface that mounts the flow routes
    // — the API, the e2e harness, the preview server — must get them too. Mounted here
    // rather than beside this router, so there is no second registration to forget.
    app.route('/', flowDraftRoutes());

    // List a guild's flows (summaries — the builder fetches the graph on open).
    app.get('/:guildId/flows', async (c) => {
        const guildId = c.get('guild').id;
        const flows = await flowsRepo.getByGuildId(guildId);

        // One index for the whole list rather than a resolve per flow: the page groups
        // by journey, so every row needs the answer and an N+1 here would be paid on
        // every visit.
        const journeys = await loadFlowJourneyIndex(
            guildId,
            flows.map((flow) => flow.flowId)
        );

        // The same index answers each row's readiness: a flow's declared keys are its
        // journey's, so `issueCount` costs no query beyond the three above. A malformed
        // journey row fails the index — and so the list — exactly as it did before
        // readiness was on it; no row is judged against a guess.
        return c.json({
            flows: flows.map((flow) => flowSummary(flow, journeys.get(flow.flowId))),
        });
    });

    // One flow with its full graph, and what stands between it and going live.
    app.get('/:guildId/flows/:flowId', async (c) => {
        const guildId = c.get('guild').id;
        const flow = await flowsRepo.getByFlowId(c.req.param('flowId'));
        // Guild mismatch is a 404, not a 403 — never confirm another guild's flow exists.
        if (!flow || flow.guildId !== guildId) {
            return c.json({ error: 'Flow not found.' }, 404);
        }

        // Named 500 rather than `issues: []`, which would claim a flow is ready when the
        // server cannot say. Not a new dead end: the builder also reads the flow's
        // resources on open, which fails on the same malformed journey row.
        const declared = await readDeclaredKeys(guildId, flow.flowId);
        if (!declared.ok) {
            return c.json({ error: declared.error }, 500);
        }

        return c.json(flowDetail(flow, flowReadinessIssues(flow.graph, declared.keys)));
    });

    /*
     * What a save of this graph would say is wrong with it. Changes nothing.
     *
     * The builder asks as an author leaves a field, so a fixed problem stops being
     * marked without a save. Judged exactly as the PUT judges — the same structural 400,
     * the same declarations, the same readiness — so the answer here cannot disagree
     * with the one Save gives a moment later.
     */
    app.post('/:guildId/flows/:flowId/check', async (c) => {
        const guildId = c.get('guild').id;
        const flowId = c.req.param('flowId');
        const flow = await flowsRepo.getByFlowId(flowId);
        if (!flow || flow.guildId !== guildId) {
            return c.json({ error: 'Flow not found.' }, 404);
        }

        const parsed = checkFlowBody.safeParse(await c.req.json().catch(() => null));
        if (!parsed.success) {
            return c.json({ error: parsed.error.issues[0]?.message ?? 'Invalid request body.' }, 400);
        }

        const structural = validateFlowGraph(parsed.data.graph);
        if (!structural.valid) {
            return c.json(invalidGraphBody(structural.errors), 400);
        }

        const declared = await readDeclaredKeys(guildId, flow.flowId);
        if (!declared.ok) {
            return c.json({ error: declared.error }, 500);
        }

        return c.json({ issues: flowReadinessIssues(structural.graph, declared.keys) });
    });

    // Create a flow. Starts empty + disabled unless a graph is supplied.
    app.post('/:guildId/flows', async (c) => {
        const guildId = c.get('guild').id;
        const parsed = createFlowBody.safeParse(await c.req.json().catch(() => null));
        if (!parsed.success) {
            return c.json({ error: parsed.error.issues[0]?.message ?? 'Invalid request body.' }, 400);
        }

        const structural = validateFlowGraph(
            parsed.data.graph ?? { version: FLOW_GRAPH_VERSION, nodes: [], edges: [] }
        );
        if (!structural.valid) {
            return c.json(invalidGraphBody(structural.errors), 400);
        }

        // No flow yet, so no journey and nothing declared. Correct rather than a
        // shortcut: a flow cannot reference a declaration it has not saved. An
        // incomplete graph is stored all the same — a new flow starts switched off.
        const issues = flowReadinessIssues(structural.graph, new Set<string>());

        const flow = await flowsRepo.create({
            guildId,
            name: parsed.data.name,
            graph: structural.graph,
            enabled: false,
        });

        return c.json(flowDetail(flow, issues), 201);
    });

    /*
     * Update name / enabled / graph.
     *
     * A graph too broken to walk is refused outright. Anything else is judged by
     * `decidePut`, against the row as it stands inside the write's own transaction: an
     * incomplete graph is stored on a flow that is off, kept as the saver's draft on one
     * that is live (`savedAs: 'draft'`, flow untouched), and a switch-on is refused (400)
     * when the graph it would run is incomplete or still waiting on its install.
     * Switching off, or renaming, is never refused for readiness.
     */
    app.put('/:guildId/flows/:flowId', async (c) => {
        const guildId = c.get('guild').id;
        const flowId = c.req.param('flowId');
        const user = c.get('user');
        const saver: FlowSaver = { id: user.id, name: user.username };
        const existing = await flowsRepo.getByFlowId(flowId);
        if (!existing || existing.guildId !== guildId) {
            return c.json({ error: 'Flow not found.' }, 404);
        }

        const parsed = updateFlowBody.safeParse(await c.req.json().catch(() => null));
        if (!parsed.success) {
            return c.json({ error: parsed.error.issues[0]?.message ?? 'Invalid request body.' }, 400);
        }

        let graph: FlowGraph | undefined;
        if (parsed.data.graph !== undefined) {
            const structural = validateFlowGraph(parsed.data.graph);
            if (!structural.valid) {
                return c.json(invalidGraphBody(structural.errors), 400);
            }
            graph = structural.graph;
        }
        const request: FlowPutRequest = {
            name: parsed.data.name,
            enabled: parsed.data.enabled,
            graph,
            baseUpdatedAt: parsed.data.baseUpdatedAt,
        };

        /*
         * Read before the transaction, never inside it: `mutate` holds sqlite's one
         * connection, and the journey repos are singletons (see `mutate`).
         *
         * Only a request that *can* be refused needs the answer before writing — a graph
         * arriving, or a switch-on. For one of those a malformed journey row refuses
         * with its cause and writes nothing. A switch-off or a rename is written
         * regardless, so a malformed journey row can never hold a live flow on.
         */
        const declared = await readDeclaredKeys(guildId, flowId);
        const canBeRefused = graph !== undefined || request.enabled === true;
        if (canBeRefused && !declared.ok) {
            return c.json({ error: declared.error }, 500);
        }

        const outcome = await flowsRepo.mutate(flowId, (current) =>
            decidePut(current, request, saver, declared.ok ? declared.keys : null)
        );

        if (outcome.kind === 'missing') {
            // Deleted between the lookup above and the write.
            return c.json({ error: 'Flow not found.' }, 404);
        }
        if (outcome.kind === 'refused') {
            return c.json({ error: outcome.refusal.error, issues: outcome.refusal.issues }, 400);
        }
        if (!declared.ok) {
            // Written, and said so: the response cannot describe the stored graph
            // without the declarations, and a 500 that hid the write would send the
            // operator to retry a switch-off that already happened. Only a request that
            // could not be refused gets here, so this is never a draft.
            return c.json({ error: `Saved. ${declared.error}` }, 500);
        }

        const flow = flowDetail(outcome.flow, flowReadinessIssues(outcome.flow.graph, declared.keys));
        switch (outcome.kind) {
            case 'written':
                return c.json<FlowSaveBody>({ ...flow, savedAs: 'flow' });
            case 'drafted':
                return c.json<FlowSaveBody>({
                    ...flow,
                    savedAs: 'draft',
                    draft: flowDraft(
                        outcome.draft,
                        saver.id,
                        outcome.flow.updatedAt,
                        flowReadinessIssues(outcome.draft.graph, declared.keys)
                    ),
                    uninstalled: uninstalledResourceKeys(outcome.draft.graph, declared.keys),
                });
        }
    });

    // Deletes the flow and its drafts — unsaved work in this database, not anything in
    // the guild; see `flowsRepo.deleteByFlowId` for what is deliberately left alone.
    app.delete('/:guildId/flows/:flowId', async (c) => {
        const guildId = c.get('guild').id;
        const flowId = c.req.param('flowId');
        const existing = await flowsRepo.getByFlowId(flowId);
        if (!existing || existing.guildId !== guildId) {
            return c.json({ error: 'Flow not found.' }, 404);
        }

        await flowsRepo.deleteByFlowId(flowId);
        return c.body(null, 204);
    });

    /*
     * Post the flow's trigger buttons — the same shared path the /flow-deploy slash
     * command uses.
     *
     * No body: each `trigger.buttonClick` node carries its own destination, so there
     * is nothing for the caller to choose. A flow-level channel here would be unable
     * to express the case this route exists to serve — several buttons on one canvas
     * going to several channels.
     */
    app.post('/:guildId/flows/:flowId/deploy', async (c) => {
        const guildId = c.get('guild').id;
        const flowId = c.req.param('flowId');
        const existing = await flowsRepo.getByFlowId(flowId);
        if (!existing || existing.guildId !== guildId) {
            return c.json({ error: 'Flow not found.' }, 404);
        }

        const result = await deployFlowButtons(guildId, flowId);
        if (!result.ok) {
            return c.json({ error: result.message }, 400);
        }

        return c.json({ ok: true, posted: result.posted });
    });

    /*
     * What installing this flow's declared resources would do to the guild.
     *
     * Reads only — `previewInstall` mutates nothing — so the operator can review the
     * whole picture, refusals included, before anything is created. Built here rather
     * than derived in the browser from the declarations, because half of what makes an
     * item blocked is a fact about the guild: a name already taken, an adopted id that
     * no longer resolves, a permission model that cannot be satisfied.
     *
     * The plan is **not** handed to `/install` afterwards. See that route.
     */
    app.get('/:guildId/flows/:flowId/install-plan', async (c) => {
        const guild = c.get('guild');
        const flowId = c.req.param('flowId');
        const existing = await flowsRepo.getByFlowId(flowId);
        if (!existing || existing.guildId !== guild.id) {
            return c.json({ error: 'Flow not found.' }, 404);
        }

        const lookup = await flowJourney(guild.id, flowId);
        if (!lookup.ok) {
            return c.json({ error: lookup.error }, lookup.status);
        }

        // Read once and used for both the refusal and the plan, so the preview is
        // built against exactly the roles the install would use.
        const staffRoleIds = await guildSettingsRepo.getStaffRoleIds(guild.id);

        const refusal = journeyInstallRefusal(lookup.journey, staffRoleIds);
        if (refusal) {
            return c.json({ error: refusal }, 409);
        }

        const plan = await previewInstall({
            guild,
            journey: lookup.journey,
            staffRoleIds,
        });

        return c.json(installPlanBody(plan));
    });

    /*
     * Create the channels and roles this flow declares.
     *
     * The plan is rebuilt server-side and re-checked before anything is applied,
     * rather than accepted from the browser — the same rule as `/unpublish` and for
     * the same reason: a plan arriving over the wire is a list of snowflakes a client
     * asked us to mutate, and nothing would stop it naming resources the real plan
     * refuses. Rebuilding also catches a guild that drifted between the preview and
     * the press, which is the case the operator cannot see and would otherwise meet as
     * a half-applied install.
     *
     * The cost is that the operator confirms a preview fetched a moment earlier rather
     * than the exact plan applied. Acceptable because every rule is re-evaluated on the
     * rebuild, so drift can only ever refuse *more*: a newly blocked item makes the
     * whole plan inapplicable and comes back as the 409 below, carrying the rebuilt
     * plan so the operator is shown what changed rather than the plan they already
     * agreed to.
     *
     * A partial apply is **200, not an error**. What was created is real and bound, the
     * write-back has already wired it into the flows that picked it, and re-running
     * install converges rather than duplicating. `failure` says where it stopped.
     */
    app.post('/:guildId/flows/:flowId/install', async (c) => {
        const guild = c.get('guild');
        const flowId = c.req.param('flowId');
        const existing = await flowsRepo.getByFlowId(flowId);
        if (!existing || existing.guildId !== guild.id) {
            return c.json({ error: 'Flow not found.' }, 404);
        }

        const lookup = await flowJourney(guild.id, flowId);
        if (!lookup.ok) {
            return c.json({ error: lookup.error }, lookup.status);
        }

        // Re-read rather than carried from the preview, for the same reason the plan
        // itself is rebuilt: staff roles can change between the operator reading a
        // preview and pressing install, and the apply must use what is true now.
        const staffRoleIds = await guildSettingsRepo.getStaffRoleIds(guild.id);

        const refusal = journeyInstallRefusal(lookup.journey, staffRoleIds);
        if (refusal) {
            return c.json({ error: refusal }, 409);
        }

        const outcome = await runInstall({
            guild,
            journey: lookup.journey,
            staffRoleIds,
        });

        // 423 rather than 409: a 409 here means the server changed and the dialog
        // reloads the plan to show what, but a plan built while another install is
        // mid-apply would describe that install's half-made channels as interrupted.
        if (outcome.status === 'busy') {
            return c.json({ error: journeyBusyMessage(outcome.running) }, 423);
        }

        if (outcome.status === 'notApplicable') {
            return c.json(
                {
                    error: 'This can no longer be installed as planned — your server changed since you last looked.',
                    plan: installPlanBody(outcome.plan),
                },
                409
            );
        }

        return c.json({
            applied: outcome.applied,
            failure: outcome.failure,
            writtenCount: outcome.writeBack.writtenCount,
            updatedFlowIds: outcome.writeBack.updatedFlowIds,
            // On the wire rather than inferred from a zero count: a write-back that
            // threw and a journey nothing references both write zero settings, and
            // only one of them means the operator's flows are now broken.
            writeBackFailed: outcome.writeBack.failed === true,
            // Named individually rather than counted: "3 unresolved" tells an operator
            // nothing they can act on, whereas the resource key is the thing they
            // declared. Deduplicated because one key can be picked by several nodes.
            unresolved: [
                ...new Set(outcome.writeBack.unresolved.map((target) => target.resourceKey)),
            ],
        });
    });

    /*
     * What this flow has live in the guild.
     *
     * The delete dialog calls this first. Deleting a flow deliberately does **not**
     * clean any of it up — "offer, never assume" — so the dialog's job is to say what
     * would be left behind and offer the cleanup as its own confirmed action.
     */
    app.get('/:guildId/flows/:flowId/published', async (c) => {
        const guild = c.get('guild');
        const flowId = c.req.param('flowId');
        const existing = await flowsRepo.getByFlowId(flowId);
        if (!existing || existing.guildId !== guild.id) {
            return c.json({ error: 'Flow not found.' }, 404);
        }

        return c.json(publishedBody(await getPublishedFlowState(guild, flowId)));
    });

    /*
     * Take this flow's trigger buttons back out of the guild.
     *
     * Deliberately usable after the flow row is gone: `flow_button_messages` outlives
     * the flow precisely so orphaned buttons can still be retired, and requiring the
     * flow to exist would make the commonest cleanup impossible. So there is no
     * `flowsRepo` lookup here — the guild-scoped row lookup inside `undeployFlowButtons`
     * is the authorization boundary, and `requireGuildAccess` has already run.
     */
    app.post('/:guildId/flows/:flowId/undeploy', async (c) => {
        const guildId = c.get('guild').id;
        const result = await undeployFlowButtons(guildId, c.req.param('flowId'));
        return c.json({ results: result.results });
    });

    /*
     * Destroy the channels and roles this flow's journey created.
     *
     * The plan is rebuilt here and applied, rather than accepted from the browser: a
     * plan arriving over the wire is a list of snowflakes a client asked us to delete,
     * and nothing would stop it naming objects the real plan refuses. Rebuilding means
     * the refusals are re-derived server-side every time.
     *
     * The cost is that the operator confirms a preview fetched a moment earlier rather
     * than the exact plan applied — acceptable because every rule is re-evaluated on
     * the rebuild, so the drift can only ever refuse *more*, never delete something the
     * preview did not show.
     *
     * **The journey must belong to this flow.** A flow's journey key was its flow id by
     * convention, but journey keys are operator-supplied and a standalone journey can
     * have any key at all — including one that happens to match a flow id. Without this
     * check a URL shaped like a flow would tear down a journey that has nothing to do
     * with it, which a stale bookmark or a mistyped id is enough to reach. The
     * `/undeploy` route's argument for skipping the lookup does not transfer: button
     * rows are keyed on the flow id we wrote ourselves, not on an operator's key.
     *
     * **This check stays deliberately weaker than install's**, for the reason already
     * recorded above: a null-owner journey is let through because the operator is shown
     * the exact list before anything is destroyed and the objects were ones we created.
     * Resolving through the link table does not change that — it only fixes *which*
     * journey is torn down when the flow's key is not its id.
     *
     * **What the link table does change is the "objects were ones we created" premise.**
     * It held while a journey had one flow. A journey holding several means a teardown
     * from one flow destroys channels the others still declare and never asked to lose
     * — so a *separate* refusal fires when another flow is attached. That is not the
     * ownership check getting stricter; it is a different question, about damage to a
     * third party rather than about who owns the journey.
     */
    app.post('/:guildId/flows/:flowId/unpublish', async (c) => {
        const guild = c.get('guild');
        const flowId = c.req.param('flowId');

        const resolved = await resolveFlowJourney(guild.id, flowId);
        if (!resolved) {
            return c.json({ error: 'This flow has not installed anything to unpublish.' }, 404);
        }

        const journey = resolved.journey;
        if (!resolved.attached && journey.createdForFlowId && journey.createdForFlowId !== flowId) {
            return c.json(
                {
                    error: 'That journey belongs to a different flow. Unpublish it from there, so you can see what it will destroy.',
                },
                409
            );
        }

        // Destroying shared structure is refused outright. Every other flow on this
        // journey still declares these channels and roles, and none of them asked for
        // this; the preview-then-confirm that justifies the weaker ownership check
        // above protects the operator holding *this* flow, not the flows they are not
        // looking at.
        const others = await otherFlowsOnJourney(guild.id, journey.journeyKey, flowId, {
            flowName: (otherFlowId) => flowNameInGuild(guild.id, otherFlowId),
        });
        if (others.length > 0) {
            return c.json(
                {
                    error: sharedJourneyRefusal({
                        journeyName: journey.name,
                        action: 'Unpublishing the journey',
                        others,
                    }),
                },
                409
            );
        }

        // The resolved key, not the flow id: bindings are recorded under the journey's
        // key, and a flow attached to a journey keyed otherwise would otherwise plan a
        // teardown of nothing and report success.
        const plan = await previewUnpublish(guild, journey.journeyKey);
        const result = await unpublishJourney({ guild, approvedPlan: plan });

        if (result.refusal) {
            return c.json({ error: result.refusal }, 409);
        }

        return c.json({ results: result.results });
    });

    return app;
}
