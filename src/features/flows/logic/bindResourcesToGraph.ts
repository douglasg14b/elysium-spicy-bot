import type { FlowGraph } from '../data/flowGraph';

/**
 * Which node config key a resource key should be written into.
 *
 * Declared per node rather than guessed from the value's shape: a node's config may
 * hold several snowflakes (a channel *and* a role), and inferring which is which from
 * the string would be a coin flip — every Discord id looks the same.
 */
export interface ResourceBindingTarget {
    /** The node to write into. */
    readonly nodeId: string;
    /** The config key on that node, e.g. `roleId` or `channelId`. */
    readonly configKey: string;
    /** The provisioning resource key whose id gets written. */
    readonly resourceKey: string;
}

export interface BindResourcesResult {
    readonly graph: FlowGraph;
    /** Targets whose resource key had no live binding, so nothing was written. */
    readonly unresolved: readonly ResourceBindingTarget[];
}

/**
 * Write provisioned resource ids into a flow graph's node configs.
 *
 * This is the concrete half of the "install writes snowflakes in" decision: blocks
 * keep taking a raw snowflake and the executor is untouched, while an author never
 * has to paste an id that provisioning already knows.
 *
 * Unresolved targets are *returned rather than skipped silently*. A node left holding
 * its old id — or none — produces a block that fails at run time, far from the cause.
 * The caller decides whether that is fatal; this function refuses to hide it.
 *
 * Note the direction of the dependency: this lives in flows and consumes the
 * provisioning barrel. Provisioning never imports flows, because it is a base
 * capability and flows are one of its consumers.
 */
export function bindResourcesToGraph(
    graph: FlowGraph,
    targets: readonly ResourceBindingTarget[],
    resolved: ReadonlyMap<string, string>
): BindResourcesResult {
    const unresolved: ResourceBindingTarget[] = [];
    const byNodeId = new Map<string, ResourceBindingTarget[]>();

    for (const target of targets) {
        const discordId = resolved.get(target.resourceKey);
        if (!discordId) {
            unresolved.push(target);
            continue;
        }
        const existing = byNodeId.get(target.nodeId) ?? [];
        existing.push(target);
        byNodeId.set(target.nodeId, existing);
    }

    const nodes = graph.nodes.map((node) => {
        const nodeTargets = byNodeId.get(node.id);
        if (!nodeTargets?.length) return node;

        const data = { ...node.data };
        for (const target of nodeTargets) {
            const discordId = resolved.get(target.resourceKey);
            if (discordId) {
                data[target.configKey] = discordId;
            }
        }

        return { ...node, data };
    });

    // A target naming a node the graph does not contain is a declaration error, not
    // a missing binding — report it alongside the rest so neither is lost.
    const nodeIds = new Set(graph.nodes.map((node) => node.id));
    for (const target of targets) {
        if (!nodeIds.has(target.nodeId) && !unresolved.includes(target)) {
            unresolved.push(target);
        }
    }

    return { graph: { ...graph, nodes }, unresolved };
}
