import { Hono } from 'hono';
import { z } from 'zod';
import { flowGraphSchema, FLOW_GRAPH_VERSION, type FlowGraph } from '../../features/flows/data/flowGraph';
import { flowsRepo } from '../../features/flows/data/flowsRepo';
import type { FlowEntity } from '../../features/flows/data/flowsSchema';
import { validateAuthoredGraph, validateFlowGraph } from '../../features/flows/engine/graphValidation';
import { validateNodeData } from '../../features/flows/engine/nodeDataValidation';
import { deployFlowButtons } from '../../features/flows/logic/deployFlowButtons';
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

/**
 * Full server-side graph validation, in the order that blames the right thing:
 * shape and structural integrity, then each node's `data` against its registry
 * schema ({@link validateNodeData}), then the authoring rules.
 *
 * Node data comes in the middle so an unknown block type is reported as an
 * unknown type, rather than as a pile of complaints about handles on a block
 * nobody recognises.
 *
 * The repo enforces the same rules — it owns the write boundary, so a seed
 * script cannot bypass them. Running them here too is not redundant: it turns
 * what would surface as a 500 from a thrown repo error into a 400 naming the
 * node, which is what the builder shows its author.
 */
function validateGraphForSave(graph: FlowGraph): { ok: true; graph: FlowGraph } | { ok: false; message: string } {
    const structural = validateFlowGraph(graph);
    if (!structural.valid) {
        return { ok: false, message: structural.errors.join('; ') };
    }

    const nodeData = validateNodeData(structural.graph);
    if (!nodeData.valid) {
        return { ok: false, message: nodeData.errors.join('; ') };
    }

    const authored = validateAuthoredGraph(structural.graph);
    if (!authored.valid) {
        return { ok: false, message: authored.errors.join('; ') };
    }

    return { ok: true, graph: structural.graph };
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
        const validated = validateGraphForSave(graph);
        if (!validated.ok) {
            return c.json({ error: validated.message }, 400);
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
            const validated = validateGraphForSave(parsed.data.graph);
            if (!validated.ok) {
                return c.json({ error: validated.message }, 400);
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

    return app;
}
