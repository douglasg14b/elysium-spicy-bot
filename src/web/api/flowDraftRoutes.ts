import { Hono } from 'hono';
import { z } from 'zod';
import { flowDraftsRepo } from '../../features/flows/data/flowDraftsRepo';
import { flowGraphSchema } from '../../features/flows/data/flowGraph';
import { flowsRepo } from '../../features/flows/data/flowsRepo';
import { validateFlowGraph } from '../../features/flows/engine/graphValidation';
import { readDeclaredKeys } from '../../features/flows/logic/declaredResourceKeys';
import { flowReadinessIssues } from '../../features/flows/logic/flowReadiness';
import type { AppEnv } from '../types';
import { flowDraft, flowDraftBaseSchema, flowDraftSummary, flowNameSchema, invalidGraphBody } from './flowBody';

/**
 * Drafts of one flow — every operator's unsaved canvas — under
 * `/:guildId/flows/:flowId/drafts`. Mounted by `flowRoutes()`, so it sits behind the
 * same `requireAuth` + `requireGuildAccess` and every surface that serves flows serves
 * these.
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

const saveDraftBody = z.object({
    name: flowNameSchema,
    graph: flowGraphSchema,
    baseUpdatedAt: flowDraftBaseSchema,
});

export function flowDraftRoutes(): Hono<AppEnv> {
    const app = new Hono<AppEnv>();

    /*
     * Every draft of the flow, graphs included — the picker loads one without a second
     * request. Each carries its readiness issues, judged against the flow's declarations,
     * so a loaded draft's cards come up marked; a malformed journey row is the same named
     * 500 `GET /flows/:flowId` gives.
     */
    app.get('/:guildId/flows/:flowId/drafts', async (c) => {
        const guildId = c.get('guild').id;
        const viewerId = c.get('user').id;
        const flow = await flowsRepo.getByFlowId(c.req.param('flowId'));
        if (!flow || flow.guildId !== guildId) {
            return c.json({ error: 'Flow not found.' }, 404);
        }

        const drafts = await flowDraftsRepo.listByFlowId(flow.flowId);
        if (drafts.length === 0) {
            // Nothing to judge, so no journey read — which is every open of a flow
            // nobody left unfinished.
            return c.json({ drafts: [] });
        }

        const declared = await readDeclaredKeys(guildId, flow.flowId);
        if (!declared.ok) {
            return c.json({ error: declared.error }, 500);
        }

        return c.json({
            drafts: drafts.map((draft) =>
                flowDraft(draft, viewerId, flow.updatedAt, flowReadinessIssues(draft.graph, declared.keys))
            ),
        });
    });

    /*
     * Write the caller's draft — the builder's autosave. Structural check only, the same
     * 400 a flow save gives; an incomplete graph is what drafts are for.
     *
     * `baseUpdatedAt` comes from the page — the flow version its canvas descends from —
     * because only the page knows what it loaded; see `FlowDraftInput.baseUpdatedAt`.
     * It only feeds the picker's "flow saved since" note, so trusting it risks nothing.
     */
    app.put('/:guildId/flows/:flowId/drafts/mine', async (c) => {
        const guildId = c.get('guild').id;
        const user = c.get('user');
        const flow = await flowsRepo.getByFlowId(c.req.param('flowId'));
        if (!flow || flow.guildId !== guildId) {
            return c.json({ error: 'Flow not found.' }, 404);
        }

        const parsed = saveDraftBody.safeParse(await c.req.json().catch(() => null));
        if (!parsed.success) {
            return c.json({ error: parsed.error.issues[0]?.message ?? 'Invalid request body.' }, 400);
        }

        const structural = validateFlowGraph(parsed.data.graph);
        if (!structural.valid) {
            return c.json(invalidGraphBody(structural.errors), 400);
        }

        const draft = await flowDraftsRepo.upsertMine({
            flowId: flow.flowId,
            guildId,
            authorId: user.id,
            authorName: user.username,
            name: parsed.data.name,
            graph: structural.graph,
            baseUpdatedAt: parsed.data.baseUpdatedAt,
        });

        return c.json(flowDraftSummary(draft, user.id, flow.updatedAt));
    });

    /*
     * Discard one draft of this flow, whoever wrote it. Scoped to the flow in the repo,
     * so a draft id lifted from another flow's picker is a 404 here, not a deletion.
     */
    app.delete('/:guildId/flows/:flowId/drafts/:draftId', async (c) => {
        const guildId = c.get('guild').id;
        const flow = await flowsRepo.getByFlowId(c.req.param('flowId'));
        if (!flow || flow.guildId !== guildId) {
            return c.json({ error: 'Flow not found.' }, 404);
        }

        const draftId = z.coerce.number().int().positive().safeParse(c.req.param('draftId'));
        if (!draftId.success || !(await flowDraftsRepo.deleteById(flow.flowId, draftId.data))) {
            return c.json({ error: 'Draft not found.' }, 404);
        }

        return c.body(null, 204);
    });

    return app;
}
