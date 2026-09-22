/**
 * Which `{{var.…}}` names are in scope at a node, and what wrote them.
 *
 * Authoring a variable is two halves that never meet on screen: one block names
 * the value it writes, and some later block's copy reads `{{var.thatName}}`. Until
 * this existed, the only thing connecting them was the author's memory — a typo
 * surfaced at *run* time, as a token that silently resolved to nothing.
 *
 * Everything here reads declarations off the descriptor. No block type appears in
 * this file, and none should: a block announces what it writes through `outputs`,
 * which is what makes this one rule instead of a list of producers to maintain.
 */

import type { Edge } from '@xyflow/react';
import type { BlockOutputDeclaration, NodeDescriptor } from '../api/types';

/** One variable an author can reference, and the block that produces it. */
export interface AvailableVariable {
    /** The bare name, as `{{var.<name>}}` addresses it. */
    readonly name: string;
    /** The producing block's label, e.g. `Pick at Random`. */
    readonly producerLabel: string;
    /** The producing block's glyph, for the list in the inspector. */
    readonly producerIcon: string;
    /** What the producer says this value is. */
    readonly description?: string;
}

/** The fields this module needs off a canvas node. React Flow's own type is wider. */
export interface VariableSourceNode {
    readonly id: string;
    readonly data: {
        readonly label: string;
        readonly config: Record<string, unknown>;
        readonly descriptor: NodeDescriptor | undefined;
    };
}

/**
 * The variable name one declared output writes on one node.
 *
 * The browser's half of the discriminator, mirroring `resolveOutputName` in
 * `src/features/flows/blocks/manifest.ts`. `undefined` means this node does not
 * produce the value *yet* — an `authored` output whose field the author has not
 * filled in. Deliberately not falling back to `fromField`: offering that name
 * would invite an author to write `{{var.outputKey}}`, which nothing ever writes.
 */
export function resolveOutputName(
    output: BlockOutputDeclaration,
    config: Record<string, unknown>
): string | undefined {
    if (output.naming === 'fixed') {
        return output.key;
    }

    const authored = config[output.fromField];
    return typeof authored === 'string' && authored ? authored : undefined;
}

/**
 * Every node that can run before `nodeId`, nearest first.
 *
 * "Before" is **reachability**, not proximity: a node is an ancestor when some
 * path reaches this one from it. On a branching graph that is a deliberate
 * over-approximation — two exclusive branches are both ancestors, though only one
 * runs. Every caller here is an authoring aid, and for all of them a fact stated
 * about a branch the author is not on costs less than a fact withheld from the
 * branch they are.
 *
 * Walks **backwards** from the node rather than forwards from every trigger, so
 * the cost is the size of the node's ancestry rather than of the graph. Cycles
 * terminate on `seen`; the builder does not prevent them, and a graph holding one
 * must still open.
 *
 * The node itself is excluded. A block cannot read what it has not written yet,
 * and `action.pickRandom` referencing its own pick would be a loop with no value.
 *
 * Shared rather than walked once per question: every additional answer derived
 * from a node's ancestry — what is in scope, whether the actor survived — is one
 * more chance for a second walk to terminate on a cycle differently, or to
 * disagree about whether an undrawable block passes a run through.
 */
export function ancestorsOf(
    nodeId: string,
    nodes: readonly VariableSourceNode[],
    edges: readonly Edge[]
): VariableSourceNode[] {
    const byId = new Map(nodes.map((node) => [node.id, node]));

    // Built once per call rather than per hop: a node with several ancestors
    // would otherwise rescan every edge for each of them.
    const incoming = new Map<string, string[]>();
    for (const edge of edges) {
        const sources = incoming.get(edge.target);
        if (sources) {
            sources.push(edge.source);
        } else {
            incoming.set(edge.target, [edge.source]);
        }
    }

    const seen = new Set<string>([nodeId]);
    const queue = [...(incoming.get(nodeId) ?? [])];
    const ancestors: VariableSourceNode[] = [];

    while (queue.length > 0) {
        const currentId = queue.shift();
        if (!currentId || seen.has(currentId)) {
            continue;
        }
        seen.add(currentId);

        const node = byId.get(currentId);
        if (node) {
            ancestors.push(node);
        }

        // Pushed even for a node this build cannot draw: an unknown block still
        // passes a run through, so what is *behind* it is still in scope.
        queue.push(...(incoming.get(currentId) ?? []));
    }

    return ancestors;
}

/**
 * Every variable in scope at `nodeId`, in the order a run would write them.
 *
 * "In scope" is the reachability {@link ancestorsOf} defines: a variable is
 * offered when some block that can run before this one writes it.
 */
export function availableVariablesAt(
    nodeId: string,
    nodes: readonly VariableSourceNode[],
    edges: readonly Edge[]
): AvailableVariable[] {
    const ancestors = ancestorsOf(nodeId, nodes, edges);

    /*
     * Nearest producer wins on a duplicate name. Two blocks writing the same
     * variable is a real graph — the run's bag holds whichever wrote last — and
     * the breadth-first walk above visits nearer ancestors first, so the first
     * entry for a name is the one whose value the reader is most likely to see.
     */
    const found = new Map<string, AvailableVariable>();
    for (const node of ancestors) {
        const descriptor = node.data.descriptor;
        if (!descriptor) {
            continue;
        }

        for (const output of descriptor.outputs) {
            const name = resolveOutputName(output, node.data.config);
            if (!name || found.has(name)) {
                continue;
            }

            found.set(name, {
                name,
                producerLabel: node.data.label,
                producerIcon: descriptor.icon,
                description: output.description,
            });
        }
    }

    return [...found.values()];
}

/**
 * Whether `{{actor.mention}}` can be relied on at this node.
 *
 * The actor is whoever caused the *current step*, not whoever started the run —
 * and a run the clock woke was caused by nobody. So the token stops resolving
 * after a block that parks the run, and the engine fails the step rather than
 * sending copy with a hole in it.
 *
 * `canSuspend` is the closest thing the browser has to that question. It is looser
 * in one direction only: every *resumed* run genuinely has no actor — the resume
 * path hardcodes `actor: undefined` (`engine/flowRunResume.ts`), so a block that
 * actually parked always loses it — but a block that *can* suspend does not always
 * park, and a graph may route around it entirely. So this answers "could the run
 * reaching this node have been woken by the clock", which is the question worth
 * warning on, and the picker greys the chip rather than removing it.
 *
 * A block this build cannot draw counts as non-suspending. The same asymmetry
 * {@link ancestorsOf} takes with unknown blocks, and in the same direction: for
 * an aid that is advice rather than enforcement, a chip wrongly offered costs a
 * keystroke, and a chip wrongly withheld costs an author the token they needed.
 */
export function actorAvailableAt(
    nodeId: string,
    nodes: readonly VariableSourceNode[],
    edges: readonly Edge[]
): boolean {
    return !ancestorsOf(nodeId, nodes, edges).some((node) => node.data.descriptor?.canSuspend);
}

/** The token an author writes to read a variable, e.g. `{{var.pick}}`. */
export function variableToken(name: string): string {
    return `{{var.${name}}}`;
}

/**
 * Every `{{…}}` the engine would *see* in one piece of copy, contents trimmed.
 *
 * Mirrors `TOKEN_PATTERN` in `src/features/flows/engine/copyRendering.ts`, and is
 * permissive for the reason stated there: a token has to be seen in order to be
 * reported by name. Narrowing it to what resolves would leave `{{subject.nmae}}`
 * looking like ordinary text right up until it reached a member with its braces on.
 */
export const TOKEN_PATTERN = /\{\{\s*([^{}]*?)\s*\}\}/g;

export function tokensIn(copy: string): string[] {
    return [...copy.matchAll(TOKEN_PATTERN)].map((match) => match[1]);
}

/**
 * The bare name of a `{{var.…}}` token, or `undefined` for anything else.
 *
 * Single dotted segment only, because the run's variable bag is flat: the engine
 * *sees* `{{var.a.b}}` and refuses to resolve it, so reporting it as "not a
 * variable reference" would make the builder disagree with save-time validation.
 */
export function variableNameOf(token: string): string | undefined {
    const [namespace, name, ...rest] = token.split('.');
    return namespace === 'var' && name && rest.length === 0 ? name : undefined;
}

/**
 * Every `{{var.…}}` name one piece of authored copy references.
 *
 * Deliberately two steps, mirroring `copyRendering.ts` on the server: a broad
 * `{{…}}` scan, then `var.<name>` off the trimmed contents. A single regex that
 * tried to do both would drift from the engine's grammar in exactly the cases
 * that matter — `{{var.a.b}}` and `{{var.a b}}` are tokens the engine *sees* and
 * refuses to resolve, and copy containing one is copy whose run fails. Reporting
 * them as "no variable referenced" would make this list quietly disagree with
 * what the author is told at save time.
 */
export function referencedVariables(copy: string): string[] {
    const names = new Set<string>();

    for (const token of tokensIn(copy)) {
        const name = variableNameOf(token);
        if (name) {
            names.add(name);
        }
    }

    return [...names];
}
