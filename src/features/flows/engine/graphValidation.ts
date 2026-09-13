import { getBlockDefinition } from '../blocks/registry';
import { flowGraphSchema, type FlowGraph } from '../data/flowGraph';

export type GraphValidationResult =
    | { valid: true; graph: FlowGraph }
    | { valid: false; errors: string[] };

/**
 * Validate the graph shape (Zod) AND enforce the structural integrity the
 * executor relies on:
 *  - every edge endpoint references an existing node
 *  - node ids are unique
 *
 * These are **corruption** checks, which is why they run on read as well as on
 * write: a graph failing one of them cannot be walked at all. Authoring mistakes
 * that merely make a flow *wrong* belong in {@link validateAuthoredGraph}, which
 * runs only where a graph is being written — a rule added here would make every
 * flow in a guild unreadable the moment one old row stopped satisfying it.
 *
 * Cycles are **permitted** as of Phase 5: back-edges are how a flow expresses a
 * loop (typically with an `action.delay` in the cycle so it parks between
 * iterations). Runaway loops are bounded at runtime instead, by the
 * `FLOW_MAX_NODE_VISITS` budget, which the executor carries across suspend /
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
 * The rules a graph must satisfy to be *written*, on top of structural integrity.
 *
 * Deliberately separate from {@link validateFlowGraph}: these catch a flow that
 * is wrong rather than one that is unreadable, so applying them on read would
 * strand graphs an earlier build happily saved — and take every other flow in
 * the guild down with them, since one throw fails the whole query.
 *
 * Checked here:
 *  - no output handle carries more than one outgoing edge
 *  - every `sourceHandle` names a handle the source block actually declares
 *  - no block requiring an `interaction` sits only on paths that cannot have one
 *
 * The first two exist because the executor follows exactly one edge per handle.
 * A second edge on a handle is a branch that silently never runs; an edge on a
 * handle no block declares is a branch that can never be reached at all, and
 * before this check the run would report success having quietly done nothing.
 *
 * Requires the block registry, so callers must have awaited discovery.
 */
export function validateAuthoredGraph(graph: FlowGraph): GraphValidationResult {
    const errors: string[] = [];

    // Counted per source node, then per handle, so no handle name can collide
    // with another through a shared key separator. An edge the graph persists
    // without a `sourceHandle` leaves by the block's default exit, which is
    // still one handle.
    const handleUseByNode = new Map<string, Map<string | undefined, number>>();
    const nodesById = new Map(graph.nodes.map((node) => [node.id, node]));

    for (const edge of graph.edges) {
        const byHandle = handleUseByNode.get(edge.source) ?? new Map<string | undefined, number>();
        const handle = edge.sourceHandle ?? undefined;
        byHandle.set(handle, (byHandle.get(handle) ?? 0) + 1);
        handleUseByNode.set(edge.source, byHandle);
    }

    for (const [sourceId, byHandle] of handleUseByNode) {
        const node = nodesById.get(sourceId);
        const block = node ? getBlockDefinition(node.type) : undefined;

        for (const [handle, count] of byHandle) {
            const named = handle === undefined ? 'its default output' : `its "${handle}" output`;

            if (count > 1) {
                errors.push(
                    `Node ${sourceId} has ${count} edges leaving ${named}, but a handle may have only one. ` +
                        'Remove the extra connections, or only one of those branches will ever run.'
                );
            }

            // An unknown block type is `validateNodeData`'s finding to report; do
            // not also blame its handles for a type nobody recognises.
            if (!block) {
                continue;
            }

            const declared = block.handles.some((candidate) => (candidate.id ?? undefined) === handle);
            if (!declared) {
                const names = block.handles
                    .map((candidate) => (candidate.id === undefined ? 'its default output' : `"${candidate.id}"`))
                    .join(', ');
                errors.push(
                    `Node ${sourceId} (${node?.type}) has an edge leaving ${named}, which ${block.label} ` +
                        `does not have. Its outputs are: ${names}.`
                );
            }
        }
    }

    errors.push(...checkContextRequirements(graph));

    return errors.length > 0 ? { valid: false, errors } : { valid: true, graph };
}

/**
 * Everything a graph must satisfy before it is stored: structural integrity,
 * then the authoring rules.
 *
 * **This is the write boundary.** It lives in the repo's create and update paths
 * rather than in the HTTP layer, so a seed script, an import tool, or any future
 * writer gets the same guarantees the builder does — a graph the executor cannot
 * walk correctly should be impossible to persist, whoever is doing the writing.
 *
 * Needs the block registry, so a caller must have awaited discovery. That is
 * true of the bot (init awaits it before the web server starts) and of any
 * script, which is why the seed script awaits it explicitly.
 */
export function validateGraphForWrite(candidate: unknown): GraphValidationResult {
    const structural = validateFlowGraph(candidate);
    if (!structural.valid) {
        return structural;
    }

    return validateAuthoredGraph(structural.graph);
}

/**
 * Reject a block that needs an `interaction` but can only ever be reached
 * without one.
 *
 * Only `interaction` is checkable this way. Every run has a member, so `member`
 * is a requirement nothing in a graph can violate; an interaction exists only
 * when the run was started by one, and is gone for good once a run parks and
 * resumes. So the question is exactly: does every trigger that reaches this node
 * carry an interaction, and does the path get there without parking?
 *
 * A node reachable from no trigger at all is not flagged — it is unreachable, so
 * it never runs, and blaming its requirements would bury the real problem.
 */
function checkContextRequirements(graph: FlowGraph): readonly string[] {
    const nodesById = new Map(graph.nodes.map((node) => [node.id, node]));
    const outgoing = new Map<string, string[]>();
    for (const edge of graph.edges) {
        outgoing.set(edge.source, [...(outgoing.get(edge.source) ?? []), edge.target]);
    }

    const walkFrom = (starts: readonly string[]): Set<string> => {
        const seen = new Set<string>();
        const queue = [...starts];
        while (queue.length > 0) {
            const id = queue.shift();
            if (id === undefined || seen.has(id)) {
                continue;
            }
            seen.add(id);
            queue.push(...(outgoing.get(id) ?? []));
        }
        return seen;
    };

    // Everything downstream of a block that parks. The question is deliberately
    // "can this node EVER be entered after a resume", not "does some good path
    // exist" — a node an author can reach both ways still runs without an
    // interaction on the lap that comes back round through the wait, and a graph
    // that validated clean would then fail on its second iteration.
    const parkedStarts = graph.nodes
        .filter((node) => getBlockDefinition(node.type)?.canSuspend)
        .flatMap((node) => outgoing.get(node.id) ?? []);
    const afterParking = walkFrom(parkedStarts);

    // Nodes some trigger can reach at all. An unreachable node never runs, so
    // blaming its requirements would bury whatever actually made it unreachable.
    const triggerIds = graph.nodes
        .filter((node) => getBlockDefinition(node.type)?.kind === 'trigger')
        .map((node) => node.id);
    const reachableAtAll = walkFrom(triggerIds);

    // A gateway trigger never has an interaction, so everything it reaches is
    // suspect for the same reason a resumed path is.
    const gatewayStarts = graph.nodes
        .filter((node) => {
            const block = getBlockDefinition(node.type);
            return block?.kind === 'trigger' && !block.requires.includes('interaction');
        })
        .map((node) => node.id);
    const fromGateway = walkFrom(gatewayStarts);

    const errors: string[] = [];
    for (const node of graph.nodes) {
        const block = getBlockDefinition(node.type);
        if (!block?.requires.includes('interaction')) {
            continue;
        }
        // A trigger requiring an interaction supplies its own.
        if (block.kind === 'trigger' || !reachableAtAll.has(node.id)) {
            continue;
        }

        const viaGateway = fromGateway.has(node.id);
        const viaResume = afterParking.has(node.id);
        if (!viaGateway && !viaResume) {
            continue;
        }

        const because = viaResume
            ? 'it can be reached after a block that parks the run, and a resumed run has no interaction'
            : 'it can be reached from a trigger that fires on a gateway event, which has no interaction';
        errors.push(
            `Node ${node.id} (${node.type}) needs the interaction that started the run, but ${because}. ` +
                'Move it before the wait, or start this path from a button.'
        );
    }

    return errors;
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
