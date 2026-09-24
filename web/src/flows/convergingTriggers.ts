/**
 * Which nodes more than one trigger reaches, and therefore run more than once.
 *
 * ## Why this is worth saying out loud
 *
 * Every matching trigger starts its **own run** — that is deliberate, and the
 * alternative (one run per event, whichever trigger got there first) was a defect that
 * left the second branch silently dead. But two triggers on one canvas routinely
 * converge on the same downstream action, because that is the natural way to draw
 * "greet them whether they joined or reacted". Two runs through one `action.sendMessage`
 * is two messages. Through `action.openTicket` it is two tickets, two channels, and two
 * numbers off the guild's sequence, which re-running cannot undo.
 *
 * `trigger.memberJoin` makes this sharp rather than theoretical: its config schema is
 * `z.object({})`, so every memberJoin trigger on a canvas is indistinguishable and all
 * of them match every join. Converging is the *only* way two of them can differ.
 *
 * ## Why an advisory rather than a rule
 *
 * Running twice is sometimes exactly what the author meant — two triggers into one
 * "log it" branch is a reasonable diagram. So this must not block a save, and the
 * engine must not de-duplicate: collapsing the runs would resurrect the dead-branch
 * defect in a new costume, and picking *which* run to drop is a decision nothing here
 * can make correctly.
 *
 * What the author cannot do today is *see* it. The canvas draws two edges into a node
 * and says nothing about how many times it will fire. That is the whole gap.
 *
 * Computed in the browser off the live graph, for the reasons
 * {@link unreachableNodeIds} sets out at length: a verdict returned by a save describes
 * the graph that was saved and is wrong the moment an author drags an edge.
 */

import type { Edge } from '@xyflow/react';
import type { NodeDescriptor } from '../api/types';

/** The fields this module needs off a canvas node. React Flow's own type is wider. */
export interface ConvergenceNode {
    readonly id: string;
    readonly data: {
        readonly descriptor: NodeDescriptor | undefined;
    };
}

/**
 * How many distinct triggers reach each node that more than one reaches.
 *
 * Keyed by node id, and a node reached by one trigger (or none) is **absent** rather
 * than present with a count of 1 — the map is the set of things worth saying, so a
 * caller can ask `.get(id)` and render nothing on `undefined`.
 *
 * The count matters rather than a boolean: "this runs twice" and "this runs four times"
 * are different amounts of trouble, and the author is the only one who can say whether
 * either is intended.
 *
 * A trigger is never itself reported, even when another trigger's path reaches it. It
 * is an entry point, not a step, and a run does not re-enter one.
 */
export function convergingTriggerCounts(
    nodes: readonly ConvergenceNode[],
    edges: readonly Edge[]
): ReadonlyMap<string, number> {
    const triggerIds = nodes
        .filter((node) => node.data.descriptor?.kind === 'trigger')
        .map((node) => node.id);

    // One trigger cannot converge with itself, and zero cannot converge at all.
    if (triggerIds.length < 2) return new Map();

    // Built once rather than per walk, matching `unreachableNodeIds`.
    const outgoing = new Map<string, string[]>();
    for (const edge of edges) {
        const targets = outgoing.get(edge.source);
        if (targets) {
            targets.push(edge.target);
        } else {
            outgoing.set(edge.source, [edge.target]);
        }
    }

    const isTrigger = new Set(triggerIds);
    /** How many distinct triggers have reached each node. */
    const reachedBy = new Map<string, number>();

    for (const triggerId of triggerIds) {
        // Seeded with the trigger so a cycle back to it terminates, but the trigger
        // itself is never counted as reached — see below.
        const seen = new Set<string>([triggerId]);
        const queue = [...(outgoing.get(triggerId) ?? [])];

        while (queue.length > 0) {
            const currentId = queue.shift();
            if (!currentId || seen.has(currentId)) {
                continue;
            }
            seen.add(currentId);

            // An entry point is not a step. A second trigger's path arriving at one
            // does not make it run twice — nothing enters a trigger.
            if (!isTrigger.has(currentId)) {
                reachedBy.set(currentId, (reachedBy.get(currentId) ?? 0) + 1);
            }

            // Walked through even for a node this build cannot draw: an unknown block
            // still passes a run through, so what is after it still runs twice.
            queue.push(...(outgoing.get(currentId) ?? []));
        }
    }

    const converging = new Map<string, number>();
    for (const [nodeId, count] of reachedBy) {
        if (count > 1) converging.set(nodeId, count);
    }

    return converging;
}

/**
 * What to tell an author about a node several triggers reach.
 *
 * States the **consequence**, not the topology. "Two triggers reach this" describes the
 * edges they are already looking at; "runs twice per event" is the part they did not
 * know and may not want.
 */
export function describeConvergence(triggerCount: number): string {
    return `${triggerCount} triggers reach this — it runs ${triggerCount} times per event.`;
}
