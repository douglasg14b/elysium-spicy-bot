import { flowGraphSchema, type FlowGraph } from '../data/flowGraph';

export type GraphValidationResult =
    | { valid: true; graph: FlowGraph }
    | { valid: false; errors: string[] };

/**
 * Validate the graph shape (Zod) AND enforce structural safety rules that the
 * executor relies on:
 *  - every edge endpoint references an existing node
 *  - node ids are unique
 *
 * Cycles are **permitted** as of Phase 5: back-edges are how a flow expresses a
 * loop (typically with an `action.delay` in the cycle so it parks between
 * iterations). Runaway loops are bounded at runtime instead, by the
 * `FLOW_MAX_NODE_VISITS` budget — which the executor carries across suspend /
 * resume so a delayed loop cannot refill it by sleeping.
 *
 * Called on read/write (repo) and at seed time so a bad graph never reaches
 * the executor.
 */
export function validateFlowGraph(candidate: unknown): GraphValidationResult {
    const parsed = flowGraphSchema.safeParse(candidate);
    if (!parsed.success) {
        return { valid: false, errors: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) };
    }

    const graph = parsed.data;
    const errors: string[] = [];

    const nodeIds = new Set<string>();
    for (const node of graph.nodes) {
        if (nodeIds.has(node.id)) {
            errors.push(`Duplicate node id: ${node.id}`);
        }
        nodeIds.add(node.id);
    }

    for (const edge of graph.edges) {
        if (!nodeIds.has(edge.source)) {
            errors.push(`Edge ${edge.id} references unknown source node: ${edge.source}`);
        }
        if (!nodeIds.has(edge.target)) {
            errors.push(`Edge ${edge.id} references unknown target node: ${edge.target}`);
        }
    }

    if (errors.length > 0) {
        return { valid: false, errors };
    }

    return { valid: true, graph };
}

/**
 * Detect a cycle via DFS with a recursion stack (white/grey/black colouring).
 *
 * No longer a validation failure — {@link validateFlowGraph} accepts cyclic
 * graphs since Phase 5. Kept because callers (the builder UI, diagnostics) may
 * still want to warn that a flow loops, e.g. a cycle with no delay in it.
 */
export function hasCycle(graph: FlowGraph): boolean {
    const adjacency = new Map<string, string[]>();
    for (const node of graph.nodes) {
        adjacency.set(node.id, []);
    }
    for (const edge of graph.edges) {
        adjacency.get(edge.source)?.push(edge.target);
    }

    const visited = new Set<string>();
    const inStack = new Set<string>();

    const visit = (nodeId: string): boolean => {
        visited.add(nodeId);
        inStack.add(nodeId);

        for (const next of adjacency.get(nodeId) ?? []) {
            if (!visited.has(next)) {
                if (visit(next)) {
                    return true;
                }
            } else if (inStack.has(next)) {
                return true;
            }
        }

        inStack.delete(nodeId);
        return false;
    };

    for (const node of graph.nodes) {
        if (!visited.has(node.id) && visit(node.id)) {
            return true;
        }
    }

    return false;
}
