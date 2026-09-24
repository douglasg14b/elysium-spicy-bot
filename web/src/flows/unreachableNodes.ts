/**
 * Which nodes no trigger can ever reach.
 *
 * A disconnected subgraph is **legal** — the save path does not refuse one, and it
 * should not: an author part-way through building a branch has one constantly. So this
 * is an advisory, not a rule, and the whole design follows from that.
 *
 * ## Why the browser computes this rather than the server
 *
 * The server already knows the answer. `checkContextRequirements` in
 * `graphValidation.ts` builds a `reachableAtAll` set and uses it only to *suppress*
 * complaints — it deliberately says nothing about unreachability itself, on the
 * grounds that blaming an unreachable node's requirements would bury whatever made it
 * unreachable. That set is a local closure, not exported, and there is no warning
 * channel on the save response to carry it out on.
 *
 * Adding one would be worse than not having it. A warning returned on a save describes
 * the graph that was *saved*; the instant the author drags one edge it is wrong, and
 * the markers would sit on the cards through exactly the work that fixes them. The
 * existing `issueCount` gets away with that because its meaning is openly "what the
 * last save found", and it is cleared wholesale on the next attempt.
 *
 * Reachability is not state — it is a pure function of nodes and edges, both of which
 * the builder already holds as the single source. Computing it in a `useMemo` is the
 * "single-source derived state" rule applied, not dodged: it is `ancestorsOf` in
 * `variables.ts`, which is the same walk in the opposite direction, for the same reason.
 *
 * ## Why an unconnected node is not marked
 *
 * A node with no edges at all is unreachable and is **deliberately left clean**. It is
 * the normal state of a block dragged from the palette a second ago, the author is
 * looking straight at it, and a marker there is the "wall of alerts" the card's own
 * `role="alert"` comment rejects. Marking it would put amber on the canvas during
 * ordinary authoring and teach the author to stop reading it.
 *
 * What cannot be seen — and what this exists for — is a cluster of *wired* nodes whose
 * path back to a trigger was cut. That looks exactly like working flow.
 */

import type { Edge } from '@xyflow/react';
import type { NodeDescriptor } from '../api/types';

/** The fields this module needs off a canvas node. React Flow's own type is wider. */
export interface ReachabilityNode {
    readonly id: string;
    readonly data: {
        readonly descriptor: NodeDescriptor | undefined;
    };
}

/**
 * Nodes that are wired to something and still cannot be reached from any trigger.
 *
 * Returns a set so a caller can ask per node without rescanning, and an empty set when
 * there is nothing worth saying — which is the answer in two cases that would otherwise
 * produce a canvas of amber:
 *
 *  - **No trigger at all.** Every node is then unreachable, which is true and useless:
 *    the flow cannot run for one reason, and stating it once per card is not how to say
 *    so. `actorAvailableAt` takes the same "advise nothing rather than advise
 *    everything" position when there is no node selected.
 *  - **A node with no edges.** See the header.
 *
 * A node this build cannot draw (`descriptor === undefined`) passes a run *through*, so
 * the walk continues past it — matching `ancestorsOf`, which pushes through an unknown
 * block for the same reason. It is never itself reported: it already renders as
 * `BrokenNodeCard` in red, and stacking an amber advisory on a red error is noise.
 */
export function unreachableNodeIds(
    nodes: readonly ReachabilityNode[],
    edges: readonly Edge[]
): ReadonlySet<string> {
    const triggerIds = nodes
        .filter((node) => node.data.descriptor?.kind === 'trigger')
        .map((node) => node.id);

    // Nothing to be reachable *from*. Every node would qualify, which is a fact about
    // the flow rather than about any card on it.
    if (triggerIds.length === 0) return new Set();

    // Built once rather than per hop, matching `ancestorsOf`: a graph with several
    // branches would otherwise rescan every edge for each of them.
    const outgoing = new Map<string, string[]>();
    const connected = new Set<string>();
    for (const edge of edges) {
        connected.add(edge.source);
        connected.add(edge.target);

        const targets = outgoing.get(edge.source);
        if (targets) {
            targets.push(edge.target);
        } else {
            outgoing.set(edge.source, [edge.target]);
        }
    }

    const reachable = new Set<string>();
    const queue = [...triggerIds];

    while (queue.length > 0) {
        const currentId = queue.shift();
        if (!currentId || reachable.has(currentId)) {
            continue;
        }
        reachable.add(currentId);

        // Pushed even for a node this build cannot draw: an unknown block still passes
        // a run through, so what is *after* it is still reached.
        queue.push(...(outgoing.get(currentId) ?? []));
    }

    const unreachable = new Set<string>();
    for (const node of nodes) {
        if (reachable.has(node.id)) continue;
        // Unwired, so the author can see it. See the header.
        if (!connected.has(node.id)) continue;
        // Already red as a broken card; amber on top of that says nothing new.
        if (!node.data.descriptor) continue;

        unreachable.add(node.id);
    }

    return unreachable;
}
