/**
 * Undo-snapshot arithmetic for deletions the canvas has already performed.
 *
 * React Flow owns the Backspace route: it removes the elements, updates its own
 * state, and only then calls `onDelete` with what went.
 * By that point "the graph as it was" is not something the page can read — the
 * mirror of live state may or may not have caught up, depending on when React
 * flushed effects, and an undo stack should not be resting on that.
 *
 * So instead of racing the update, the removed elements are added back to whatever
 * the mirror currently holds. That describes the prior graph correctly under either
 * timing: if the mirror is still stale the removed elements are already in it and
 * get de-duplicated, and if it has caught up they are missing and get restored.
 */

/** The parts of a node this needs; the real node type carries much more. */
interface Identified {
    readonly id: string;
}

export interface GraphOf<TNode extends Identified, TEdge extends Identified> {
    nodes: TNode[];
    edges: TEdge[];
}

/**
 * The graph as it was before `removed` was taken out of `current`.
 *
 * Removed elements are appended rather than spliced back at their original index.
 * Order within the node and edge arrays carries no meaning — React Flow positions
 * nodes from `position` and routes edges from `source`/`target` — and the only
 * other consumer, `serialize`, emits a set the backend re-reads by id.
 */
export function graphIncluding<TNode extends Identified, TEdge extends Identified>(
    current: GraphOf<TNode, TEdge>,
    removed: { nodes?: readonly TNode[]; edges?: readonly TEdge[] }
): GraphOf<TNode, TEdge> {
    const removedNodes = removed.nodes ?? [];
    const removedEdges = removed.edges ?? [];
    const removedNodeIds = new Set(removedNodes.map((node) => node.id));
    const removedEdgeIds = new Set(removedEdges.map((edge) => edge.id));

    return {
        nodes: [...current.nodes.filter((node) => !removedNodeIds.has(node.id)), ...removedNodes],
        edges: [...current.edges.filter((edge) => !removedEdgeIds.has(edge.id)), ...removedEdges],
    };
}
