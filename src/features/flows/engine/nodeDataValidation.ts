import type { FlowGraph } from '../data/flowGraph';
import { getBlockDefinition } from '../blocks/registry';

export type NodeDataValidationResult = { valid: true } | { valid: false; errors: string[] };

/**
 * Validate every node's `data` against its registry `configSchema`.
 *
 * {@link validateFlowGraph} only checks the graph's *shape* (ids, edges) —
 * `data` is an opaque record there. This is the second half: an unknown node
 * `type` or a `data` payload its node type rejects is an error, so a graph that
 * would fail at execution time is refused at save time instead.
 *
 * Errors are prefixed with the offending node id for the builder UI.
 */
export function validateNodeData(graph: FlowGraph): NodeDataValidationResult {
    const errors: string[] = [];

    for (const node of graph.nodes) {
        const definition = getBlockDefinition(node.type);
        if (!definition) {
            errors.push(`${node.id}: unknown node type "${node.type}"`);
            continue;
        }

        const parsed = definition.configSchema.safeParse(node.data);
        if (!parsed.success) {
            for (const issue of parsed.error.issues) {
                const field = issue.path.join('.');
                errors.push(`${node.id}: ${field ? `${field}: ` : ''}${issue.message}`);
            }
        }
    }

    return errors.length > 0 ? { valid: false, errors } : { valid: true };
}
