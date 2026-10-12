import { createRoute, z } from '@hono/zod-openapi';
import { flowDraftsRepo } from '../../features/flows/data/flowDraftsRepo';
import { flowsRepo } from '../../features/flows/data/flowsRepo';
import { validateFlowGraph } from '../../features/flows/engine/graphValidation';
import { readDeclaredKeys } from '../../features/flows/logic/declaredResourceKeys';
import { flowReadinessIssues } from '../../features/flows/logic/flowReadiness';
import {
    DECLARATIONS_UNREADABLE,
    flowDraft,
    flowDraftBaseSchema,
    FlowDraftSchema,
    flowDraftSummary,
    FlowDraftSummarySchema,
    FLOW_ERRORS,
    FLOW_GRAPH_BODY_ERRORS,
    FlowGraphSchema,
    flowNameSchema,
    FlowPathSchema,
    invalidGraphBody,
} from './flowBody';
import { errorBodyResponse, jsonBody, jsonResponse, type ApiRouteRegistrar } from './openApi';

/**
 * Drafts of one flow — every operator's unsaved canvas — under
 * `/{guildId}/flows/{flowId}/drafts`. Declared by `flowRoutes()` on its own router, so it
 * sits behind the same `requireAuth` + `requireGuildAccess`, shares its spec surface, and
 * every surface that serves flows serves these.
 *
 * **Any operator may read or discard any draft.** Operators are trusted admins of the
 * guild, and the builder shows every draft on open precisely so they can sort out who
 * was doing what; a draft only its author could discard would strand an abandoned one
 * in front of everybody else. Writing is the exception: `PUT mine` only ever writes the
 * caller's own, because the author is whoever is signed in, not a parameter.
 *
 * Every route 404s when the flow is not in this guild — never confirming another guild's
 * flow exists, exactly as the flow routes do.
 */

const FlowDraftSaveSchema = z
    .object({
        name: flowNameSchema,
        graph: FlowGraphSchema,
        baseUpdatedAt: flowDraftBaseSchema,
    })
    .openapi('FlowDraftSave', {
        description: "The caller's canvas. `baseUpdatedAt` is the flow version it was loaded from.",
    });

/**
 * The draft's id stays a string here and is read in the handler, so an id that is not a
 * positive whole number is the same 404 as one that names no draft — not a 400 from the
 * validator. From the caller's side both are "no such draft".
 */
const DraftPathSchema = FlowPathSchema.extend({
    draftId: z.string(),
});

const listFlowDraftsRoute = createRoute({
    method: 'get',
    path: '/{guildId}/flows/{flowId}/drafts',
    operationId: 'listFlowDrafts',
    tags: ['flows'],
    summary: "Every operator's draft of a flow, graphs included",
    request: { params: FlowPathSchema },
    responses: {
        200: jsonResponse(
            'The drafts, most recently edited first, each with its readiness issues.',
            z.object({ drafts: z.array(FlowDraftSchema) })
        ),
        ...FLOW_ERRORS,
        500: DECLARATIONS_UNREADABLE,
    },
});

const saveMyFlowDraftRoute = createRoute({
    method: 'put',
    path: '/{guildId}/flows/{flowId}/drafts/mine',
    operationId: 'saveMyFlowDraft',
    tags: ['flows'],
    summary: "Write the caller's own draft of a flow",
    request: { params: FlowPathSchema, body: jsonBody(FlowDraftSaveSchema) },
    responses: {
        200: jsonResponse('The draft as saved, without its graph.', FlowDraftSummarySchema),
        ...FLOW_GRAPH_BODY_ERRORS,
    },
});

const discardFlowDraftRoute = createRoute({
    method: 'delete',
    path: '/{guildId}/flows/{flowId}/drafts/{draftId}',
    operationId: 'discardFlowDraft',
    tags: ['flows'],
    summary: "Discard any operator's draft of a flow",
    request: { params: DraftPathSchema },
    responses: {
        204: { description: 'Discarded.' },
        ...FLOW_ERRORS,
        404: errorBodyResponse(
            'The bot is not in this server, the flow is not in it, or the flow has no draft with that id.'
        ),
    },
});

/** Declares the draft routes on the flow routes' router. */
export function defineFlowDraftRoutes(router: ApiRouteRegistrar): undefined {
    /*
     * Every draft of the flow, graphs included — the picker loads one without a second
     * request. Each carries its readiness issues, judged against the flow's declarations,
     * so a loaded draft's cards come up marked; a malformed journey row is the same named
     * 500 `GET /flows/:flowId` gives.
     */
    router.openapi(listFlowDraftsRoute, async (c) => {
        const guildId = c.get('guild').id;
        const viewerId = c.get('user').id;
        const flow = await flowsRepo.getByFlowId(c.req.valid('param').flowId);
        if (!flow || flow.guildId !== guildId) {
            return c.json({ error: 'Flow not found.' }, 404);
        }

        const drafts = await flowDraftsRepo.listByFlowId(flow.flowId);
        if (drafts.length === 0) {
            // Nothing to judge, so no journey read — which is every open of a flow
            // nobody left unfinished.
            return c.json({ drafts: [] }, 200);
        }

        const declared = await readDeclaredKeys(guildId, flow.flowId);
        if (!declared.ok) {
            return c.json({ error: declared.error }, 500);
        }

        return c.json(
            {
                drafts: drafts.map((draft) =>
                    flowDraft(draft, viewerId, flow.updatedAt, flowReadinessIssues(draft.graph, declared.keys))
                ),
            },
            200
        );
    });

    /*
     * Write the caller's draft — the builder's autosave. Structural check only, the same
     * 400 a flow save gives; an incomplete graph is what drafts are for.
     *
     * `baseUpdatedAt` comes from the page — the flow version its canvas descends from —
     * because only the page knows what it loaded; see `FlowDraftInput.baseUpdatedAt`.
     * It only feeds the picker's "flow saved since" note, so trusting it risks nothing.
     */
    router.openapi(saveMyFlowDraftRoute, async (c) => {
        const guildId = c.get('guild').id;
        const user = c.get('user');
        const body = c.req.valid('json');
        const flow = await flowsRepo.getByFlowId(c.req.valid('param').flowId);
        if (!flow || flow.guildId !== guildId) {
            return c.json({ error: 'Flow not found.' }, 404);
        }

        const structural = validateFlowGraph(body.graph);
        if (!structural.valid) {
            return c.json(invalidGraphBody(structural.errors), 400);
        }

        const draft = await flowDraftsRepo.upsertMine({
            flowId: flow.flowId,
            guildId,
            authorId: user.id,
            authorName: user.username,
            name: body.name,
            graph: structural.graph,
            baseUpdatedAt: body.baseUpdatedAt,
        });

        return c.json(flowDraftSummary(draft, user.id, flow.updatedAt), 200);
    });

    /*
     * Discard one draft of this flow, whoever wrote it. Scoped to the flow in the repo,
     * so a draft id lifted from another flow's picker is a 404 here, not a deletion.
     */
    router.openapi(discardFlowDraftRoute, async (c) => {
        const guildId = c.get('guild').id;
        const params = c.req.valid('param');
        const flow = await flowsRepo.getByFlowId(params.flowId);
        if (!flow || flow.guildId !== guildId) {
            return c.json({ error: 'Flow not found.' }, 404);
        }

        const draftId = z.coerce.number().int().positive().safeParse(params.draftId);
        if (!draftId.success || !(await flowDraftsRepo.deleteById(flow.flowId, draftId.data))) {
            return c.json({ error: 'Draft not found.' }, 404);
        }

        return c.body(null, 204);
    });

    return undefined;
}
