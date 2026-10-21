import { getBlockDefinition } from '../blocks/registry';
import type { FlowGraph, FlowNode } from '../data/flowGraph';
import { RESOURCE_KEY_SUFFIX, RESOURCE_PICKER_CONTROLS } from './resourceTargets';

/**
 * A graph as it is stored: every node holding only the keys its block declares.
 *
 * `node.data` is an open record on the wire — the graph's shape cannot know which block a
 * node is — and the save-time check parses it with each block's `configSchema`, which
 * judges the keys it knows and ignores the rest. So without this a request could store
 * any key at all in a flow, where nothing would ever read it or say it was there. What a
 * block declares is its `configFields` (conformance holds them to the schema both ways),
 * plus the `<field>Key` sidecar beside each picker that writes one; the builder writes
 * nothing else.
 *
 * **Stripped, not refused.** A graph saved before a field was renamed still carries the old
 * key, and the builder sends back what it loaded — refusing would 400 that flow's next
 * unrelated save. Dropping a key nothing reads changes nothing a run can see.
 *
 * A node whose block this build does not know keeps its data as it stands: there is no
 * declaration to judge it by, readiness already reports the unknown type, and the request's
 * size is bounded where the body is read.
 *
 * Asked by every route that stores a graph, after the structural check. Needs the block
 * registry, so a caller must have awaited discovery.
 */
export function withDeclaredNodeData(graph: FlowGraph): FlowGraph {
    let changed = false;
    const nodes = graph.nodes.map((node) => {
        const kept = declaredDataOf(node);
        if (kept !== node.data) changed = true;
        return kept === node.data ? node : { ...node, data: kept };
    });
    return changed ? { ...graph, nodes } : graph;
}

/** One node's data with only its block's declared keys, or the same object when nothing goes. */
function declaredDataOf(node: FlowNode): FlowNode['data'] {
    const block = getBlockDefinition(node.type);
    if (!block) return node.data;

    const declared = new Set(
        block.configFields.flatMap((field) =>
            RESOURCE_PICKER_CONTROLS.has(field.control) ? [field.key, `${field.key}${RESOURCE_KEY_SUFFIX}`] : [field.key]
        )
    );
    const entries = Object.entries(node.data);
    const kept = entries.filter(([key]) => declared.has(key));
    return kept.length === entries.length ? node.data : Object.fromEntries(kept);
}
