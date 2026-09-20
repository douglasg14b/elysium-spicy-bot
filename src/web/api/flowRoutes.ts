import { Hono } from 'hono';
import { z } from 'zod';
import { flowGraphSchema, FLOW_GRAPH_VERSION, type FlowGraph } from '../../features/flows/data/flowGraph';
import { flowsRepo } from '../../features/flows/data/flowsRepo';
import type { FlowEntity } from '../../features/flows/data/flowsSchema';
import { validateAuthoredGraph, validateFlowGraph } from '../../features/flows/engine/graphValidation';
import {
    describeIssue,
    validateNodeData,
    type FlowValidationIssue,
} from '../../features/flows/engine/nodeDataValidation';
import { deployFlowButtons } from '../../features/flows/logic/deployFlowButtons';
import { pendingResourceFields } from '../../features/flows/logic/pendingResourceFields';
import {
    getPublishedFlowState,
    type PublishedFlowState,
} from '../../features/flows/logic/publishedFlowState';
import { undeployFlowButtons } from '../../features/flows/logic/undeployFlowButtons';
import { journeysRepo } from '../../features/provisioning/data/journeysRepo';
import { previewUnpublish, unpublishJourney } from '../../features/provisioning';
import type { AppEnv } from '../types';

/**
 * Flow CRUD + deploy for the Phase 4 builder. Mounted under the `/api/guilds` route
 * group, which applies `requireAuth` and then `requireGuildAccess` — so by the time a
 * handler runs, the caller is authorized for the guild and `c.get('guild')` is the
 * resolved, bot-present guild. See design doc §5.3 / §5.5.
 */

const createFlowBody = z.object({
    name: z.string().min(1, 'Give the flow a name.').max(100, 'Flow names cap at 100 characters.'),
    graph: flowGraphSchema.optional(),
});

const updateFlowBody = z.object({
    name: z.string().min(1, 'Give the flow a name.').max(100, 'Flow names cap at 100 characters.').optional(),
    enabled: z.boolean().optional(),
    graph: flowGraphSchema.optional(),
});

const deployFlowBody = z.object({
    channelId: z.string().min(1, 'Pick a channel to deploy the buttons in.'),
});

/** The wire shape for a single flow: the full graph plus metadata. */
function flowDetail(flow: FlowEntity) {
    return {
        flowId: flow.flowId,
        name: flow.name,
        enabled: flow.enabled,
        graph: flow.graph,
        createdAt: new Date(flow.createdAt).toISOString(),
        updatedAt: new Date(flow.updatedAt).toISOString(),
    };
}

/** The wire shape for the flow list: metadata plus a node count, no graph. */
function flowSummary(flow: FlowEntity) {
    return {
        flowId: flow.flowId,
        name: flow.name,
        enabled: flow.enabled,
        nodeCount: flow.graph.nodes.length,
        createdAt: new Date(flow.createdAt).toISOString(),
        updatedAt: new Date(flow.updatedAt).toISOString(),
    };
}

type GraphSaveValidation =
    | { ok: true; graph: FlowGraph }
    | { ok: false; issues: readonly FlowValidationIssue[] };

/**
 * The resource keys a flow declares, for the pair check below.
 *
 * A flow's journey is implicit and keyed on the flow's own id, so this is a lookup
 * rather than a join. A flow that declares nothing has no journey row at all, which
 * is the normal state and not an error — hence the empty set rather than a 404.
 */
async function declaredResourceKeys(guildId: string, flowId: string): Promise<ReadonlySet<string>> {
    const journey = await journeysRepo.getByKey(guildId, flowId);
    return new Set((journey?.resources ?? []).map((resource) => resource.key));
}

/**
 * Full server-side graph validation, in the order that blames the right thing:
 * shape and structural integrity, then each node's `data` against its registry
 * schema ({@link validateNodeData}), then the authoring rules.
 *
 * Node data comes in the middle so an unknown block type is reported as an
 * unknown type, rather than as a pile of complaints about handles on a block
 * nobody recognises.
 *
 * `declaredKeys` is what lets a picker field be empty: a node that picked a
 * resource this flow declares but has not installed holds an empty snowflake and a
 * sidecar naming the declaration, and refusing that would make a whole feature
 * unsaveable. {@link pendingResourceFields} translates the declaration into the
 * engine's own vocabulary — "these fields are filled in later" — so the validator
 * stays a general check that has never heard of provisioning.
 *
 * Issues, not a joined string. Every one carries the node and field it came from,
 * which the builder puts next to the control that caused it; a dozen-node canvas
 * and a sentence naming only a field is not enough to find anything.
 *
 * The repo also enforces the structural and authoring rules on write — it owns the
 * write boundary, so a seed script cannot bypass them. It does **not** run the node
 * data check, which lives only here: it needs the flow's declarations, and a repo
 * reaching for them would invert the dependency between flows and provisioning.
 */
function validateGraphForSave(graph: FlowGraph, declaredKeys: ReadonlySet<string>): GraphSaveValidation {
    const structural = validateFlowGraph(graph);
    if (!structural.valid) {
        return { ok: false, issues: structural.errors.map((message) => ({ message })) };
    }

    const pending = pendingResourceFields(structural.graph, declaredKeys);
    const nodeData = validateNodeData(structural.graph, { pendingFields: pending.pendingFields });
    const nodeDataIssues = nodeData.valid ? [] : nodeData.issues;
    // Reported together: a sidecar naming nothing and a field the schema refuses are
    // the same author's same mistake seen from two sides, and showing one at a time
    // would make fixing it a round trip per node.
    const dataIssues = [...pending.issues, ...nodeDataIssues];
    if (dataIssues.length > 0) {
        return { ok: false, issues: dataIssues };
    }

    const authored = validateAuthoredGraph(structural.graph);
    if (!authored.valid) {
        return { ok: false, issues: authored.errors.map((message) => ({ message })) };
    }

    return { ok: true, graph: structural.graph };
}

/**
 * The 400 body for a rejected graph.
 *
 * `error` stays, and stays first: every existing client reads it, `ApiError` falls
 * back to it, and a notification with no room for a list still needs a sentence.
 * `issues` is the same information addressed to the nodes it came from.
 */
function invalidGraphBody(issues: readonly FlowValidationIssue[]): {
    error: string;
    issues: readonly FlowValidationIssue[];
} {
    return { error: issues.map(describeIssue).join('; '), issues };
}

/**
 * A thrown value as one line for an operator.
 *
 * The message only — no stack, which would be the one thing in a repo error worth
 * keeping out of a response body.
 */
function describeCause(cause: unknown): string {
    return cause instanceof Error ? cause.message : String(cause);
}

/**
 * The wire shape for what a flow has live in the guild.
 *
 * `mayHaveUnrecordedButtons` is on the wire rather than left to the browser to know,
 * because it is a fact about the *data* — buttons posted before the recording table
 * existed were never written down and cannot be found. A dialog that said "nothing is
 * published" off an empty list would be promising more than this data can support.
 */
function publishedBody(state: PublishedFlowState) {
    return {
        buttonMessages: state.buttonMessages,
        deletableResources: state.deletableResources,
        refusedResources: state.refusedResources,
        mayHaveUnrecordedButtons: state.mayHaveUnrecordedButtons,
    };
}

export function flowRoutes(): Hono<AppEnv> {
    const app = new Hono<AppEnv>();

    // List a guild's flows (summaries — the builder fetches the graph on open).
    app.get('/:guildId/flows', async (c) => {
        const flows = await flowsRepo.getByGuildId(c.get('guild').id);
        return c.json({ flows: flows.map(flowSummary) });
    });

    // One flow with its full graph.
    app.get('/:guildId/flows/:flowId', async (c) => {
        const guildId = c.get('guild').id;
        const flow = await flowsRepo.getByFlowId(c.req.param('flowId'));
        // Guild mismatch is a 404, not a 403 — never confirm another guild's flow exists.
        if (!flow || flow.guildId !== guildId) {
            return c.json({ error: 'Flow not found.' }, 404);
        }

        return c.json(flowDetail(flow));
    });

    // Create a flow. Starts empty + disabled unless a graph is supplied.
    app.post('/:guildId/flows', async (c) => {
        const guildId = c.get('guild').id;
        const parsed = createFlowBody.safeParse(await c.req.json().catch(() => null));
        if (!parsed.success) {
            return c.json({ error: parsed.error.issues[0]?.message ?? 'Invalid request body.' }, 400);
        }

        const graph: FlowGraph = parsed.data.graph ?? { version: FLOW_GRAPH_VERSION, nodes: [], edges: [] };
        // No flow yet, so no journey and nothing declared. Correct rather than a
        // shortcut: a flow cannot reference a declaration it has not saved.
        const validated = validateGraphForSave(graph, new Set<string>());
        if (!validated.ok) {
            return c.json(invalidGraphBody(validated.issues), 400);
        }

        const flow = await flowsRepo.create({
            guildId,
            name: parsed.data.name,
            graph: validated.graph,
            enabled: false,
        });

        return c.json(flowDetail(flow), 201);
    });

    // Update name / enabled / graph. Any supplied graph is fully validated first.
    app.put('/:guildId/flows/:flowId', async (c) => {
        const guildId = c.get('guild').id;
        const flowId = c.req.param('flowId');
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
            /*
             * `journeysRepo` validates the stored declaration on read and throws when
             * a row is malformed. Caught and named rather than left to become a bare
             * 500: the author would otherwise be told to "try again in a second" on a
             * graph that is fine, forever, with nothing on screen pointing at the
             * journey row that is actually broken.
             *
             * Deliberately **not** recovered from by treating the flow as declaring
             * nothing. That would turn a corrupt row into "every picked resource is
             * undeclared", blaming the author's graph for a data problem they cannot
             * see or fix.
             */
            let declaredKeys: ReadonlySet<string>;
            try {
                declaredKeys = await declaredResourceKeys(guildId, flowId);
            } catch (cause) {
                return c.json(
                    {
                        error:
                            "This flow's declared resources are stored in a state the server can't " +
                            `read, so its graph can't be checked: ${describeCause(cause)}`,
                    },
                    500
                );
            }

            const validated = validateGraphForSave(parsed.data.graph, declaredKeys);
            if (!validated.ok) {
                return c.json(invalidGraphBody(validated.issues), 400);
            }
            graph = validated.graph;
        }

        const flow = await flowsRepo.update(flowId, {
            name: parsed.data.name,
            enabled: parsed.data.enabled,
            graph,
        });

        return c.json(flowDetail(flow));
    });

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

    // Post the flow's trigger button(s) to a channel — the same shared path the
    // /flow-deploy slash command uses.
    app.post('/:guildId/flows/:flowId/deploy', async (c) => {
        const guildId = c.get('guild').id;
        const flowId = c.req.param('flowId');
        const existing = await flowsRepo.getByFlowId(flowId);
        if (!existing || existing.guildId !== guildId) {
            return c.json({ error: 'Flow not found.' }, 404);
        }

        const parsed = deployFlowBody.safeParse(await c.req.json().catch(() => null));
        if (!parsed.success) {
            return c.json({ error: parsed.error.issues[0]?.message ?? 'Invalid request body.' }, 400);
        }

        const result = await deployFlowButtons(guildId, flowId, parsed.data.channelId);
        if (!result.ok) {
            return c.json({ error: result.message }, 400);
        }

        return c.json({ ok: true, messageId: result.messageId });
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
     * Preview what unpublishing this flow's resources would do. Reads only.
     *
     * A flow's journey key is its flow id, the same convention the resource routes use.
     */
    app.get('/:guildId/flows/:flowId/unpublish-preview', async (c) => {
        const guild = c.get('guild');
        const plan = await previewUnpublish(guild, c.req.param('flowId'));
        return c.json({ items: plan.items });
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
     */
    app.post('/:guildId/flows/:flowId/unpublish', async (c) => {
        const guild = c.get('guild');
        const plan = await previewUnpublish(guild, c.req.param('flowId'));
        const result = await unpublishJourney({ guild, approvedPlan: plan });

        if (result.refusal) {
            return c.json({ error: result.refusal }, 409);
        }

        return c.json({ results: result.results });
    });

    return app;
}
