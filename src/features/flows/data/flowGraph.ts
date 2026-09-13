import { z } from 'zod';

/**
 * The node-graph model persisted in the `flows` table `graph` JSON column.
 *
 * A flow is a directed graph. Execution begins at a trigger node and walks
 * edges: action nodes run in order; condition nodes fork on their `true`/`false`
 * output handle. See §4.2 of the plan.
 *
 * Cycles are legal as of Phase 5 — a back-edge is how a flow loops. Runaway
 * loops are bounded by the executor's `FLOW_MAX_NODE_VISITS` budget, which is
 * persisted on the run row and carried across suspend/resume.
 *
 * These types + Zod schemas describe the *shape* of the graph. Per-node
 * `data` payloads are validated separately, against the `configSchema` on the
 * manifest of the block that node instantiates.
 */

export const FLOW_GRAPH_VERSION = 1 as const;

export const flowNodePositionSchema = z.object({
    x: z.number(),
    y: z.number(),
});

export const flowNodeSchema = z.object({
    /** UUID unique within the graph. Referenced by edges and button custom_ids. */
    id: z.string().min(1),
    /**
     * Which block this node instantiates — the `type` on that block's manifest.
     *
     * Kept as an open string rather than a union of the shipped types: the set is
     * discovered from the filesystem at startup, so it is not known at compile time,
     * and a graph saved against a build that has a block must still parse on a build
     * that does not. Whether the type resolves is checked by graph validation, which
     * reports an unknown one rather than failing to parse.
     */
    type: z.string().min(1),
    /** Canvas position, authored by the builder and unused at runtime. */
    position: flowNodePositionSchema,
    /** Config for this node, validated against its block's `configSchema`. */
    data: z.record(z.string(), z.unknown()),
});

export const flowEdgeSchema = z.object({
    id: z.string().min(1),
    source: z.string().min(1),
    /** Output handle on the source node, e.g. "true"/"false" for a condition. */
    sourceHandle: z.string().min(1).optional(),
    target: z.string().min(1),
    targetHandle: z.string().min(1).optional(),
});

export const flowGraphSchema = z.object({
    version: z.literal(FLOW_GRAPH_VERSION),
    nodes: z.array(flowNodeSchema),
    edges: z.array(flowEdgeSchema),
});

export type FlowNodePosition = z.infer<typeof flowNodePositionSchema>;
export type FlowNode = z.infer<typeof flowNodeSchema>;
export type FlowEdge = z.infer<typeof flowEdgeSchema>;
export type FlowGraph = z.infer<typeof flowGraphSchema>;
