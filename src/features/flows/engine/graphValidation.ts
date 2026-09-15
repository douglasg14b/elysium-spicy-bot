import type { FlowContextRequirement } from '../blocks/manifest';
import { getBlockDefinition } from '../blocks/registry';
import { flowGraphSchema, type FlowGraph } from '../data/flowGraph';
import { describeVocabulary, isCopyField, isRenderableToken, tokensIn } from './copyRendering';

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
 *  - no block requiring something from the run context sits only on paths that
 *    cannot supply it
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

    errors.push(...checkSuspendingNodesAreReachable(graph));
    errors.push(...checkContextRequirements(graph));
    errors.push(...checkCopyTokens(graph));

    return errors.length > 0 ? { valid: false, errors } : { valid: true, graph };
}

/**
 * Reject a block that parks when nothing is wired to any handle it declares.
 *
 * The executor treats such a node as not worth a row and completes the run
 * instead (`executor.ts`, the `reachable` guard) — which is the right call for a
 * delay, because a delay that leads nowhere has genuinely nothing left to do. But
 * a block that parks by *posting controls* has already committed its side effect
 * by the time that decision is reached: the buttons are in the channel, and
 * discarding the park means no `flow_runs` row is ever written for them. Every
 * press then names a run that does not exist and is told the question "may still
 * be setting up", inviting a retry that can never succeed, and nothing can
 * disable the controls because the release only runs on the resume path.
 *
 * Rejecting it at save time is the only place an author can act on it. The check
 * is deliberately on **every** suspending block rather than only the ones that
 * post: "this parks and then goes nowhere" is a mistake in an author's graph
 * whichever block does it, and singling out the posting ones would mean naming a
 * block type here — which `blockTypeBranching` rejects, and rightly.
 *
 * Iterates nodes rather than edges, unlike the loop above: a node with no
 * outgoing edges at all never appears in `handleUseByNode`, and that is precisely
 * the case this rejects.
 */
function checkSuspendingNodesAreReachable(graph: FlowGraph): string[] {
    const errors: string[] = [];
    const handlesBySource = new Map<string, Set<string | undefined>>();

    for (const edge of graph.edges) {
        const handles = handlesBySource.get(edge.source) ?? new Set<string | undefined>();
        handles.add(edge.sourceHandle ?? undefined);
        handlesBySource.set(edge.source, handles);
    }

    for (const node of graph.nodes) {
        const block = getBlockDefinition(node.type);
        if (!block?.canSuspend) {
            continue;
        }

        // Edges on handles the block does not declare do not count, matching the
        // executor's own test exactly: nothing could ever follow them.
        const used = handlesBySource.get(node.id) ?? new Set<string | undefined>();
        const reachable = block.handles.some((handle) => used.has(handle.id ?? undefined));
        if (reachable) {
            continue;
        }

        const names = block.handles
            .map((handle) => (handle.id === undefined ? 'its default output' : `"${handle.id}"`))
            .join(', ');
        errors.push(
            `Node ${node.id} (${block.label}) waits for something to happen, but nothing is connected ` +
                `to any of its outputs, so the flow would stop there. Connect one of: ${names}.`
        );
    }

    return errors;
}

/**
 * Reject copy containing a token this engine could never fill in.
 *
 * A typo like `{{subject.nmae}}` has exactly two possible fates: caught here,
 * where the author is looking at the field and can fix it, or discovered in
 * production when the run fails — or worse, when the braces are posted verbatim
 * into a channel. Save time is the only one of those an author can act on.
 *
 * Fields are found by their own declaration (`rendersTokens`) rather than by
 * block type, which is what keeps this one rule instead of a branch per block.
 *
 * **`{{var.<name>}}` is accepted on sight**, deliberately. When produced names
 * become checkable this is where it tightens: a variable no upstream block on the
 * path produces becomes an error naming the node, exactly as an unknown token is
 * now.
 *
 * **Read this before building that check.** One shipped block now declares a
 * non-empty `outputs` (`blocks/actionPickRandom`), so the member is no longer
 * uniformly empty — but that entry's `key` names a **config field**, not the
 * variable written: the block calls `setOutput(config.outputKey, …)`, so the
 * produced name is whatever the author typed. Walking `outputs` and reading `key`
 * as a variable name would therefore reject the one correct graph (the block
 * writes `pick`, downstream copy reads `{{var.pick}}`) while accepting
 * `{{var.outputKey}}`, which nothing ever writes. A manifest needs a way to say
 * "this output is named by that config field" before this check can be written.
 */
function checkCopyTokens(graph: FlowGraph): readonly string[] {
    const errors: string[] = [];

    for (const node of graph.nodes) {
        const block = getBlockDefinition(node.type);
        if (!block) {
            continue;
        }

        for (const field of block.configFields) {
            // The same predicate the executor renders by, so a field the engine
            // would expand cannot be one this check quietly skips.
            if (!isCopyField(field)) {
                continue;
            }

            const value = node.data[field.key];
            if (typeof value !== 'string') {
                continue;
            }

            for (const token of tokensIn(value)) {
                if (isRenderableToken(token)) {
                    continue;
                }
                errors.push(
                    `Node ${node.id} (${node.type}) has "${field.label}" containing {{${token}}}, which is not ` +
                        `something a flow can fill in. ${describeVocabulary()}`
                );
            }
        }
    }

    return errors;
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
 * Why a requirement can be unsatisfiable on a path, and what to tell the author
 * when it is.
 *
 * Two questions decide it for every requirement alike — can this node be reached
 * after a park, and can it be reached from a trigger whose event never supplies
 * the thing — so this is data rather than three copies of one walk.
 *
 * **A message is present exactly when that route can lose the requirement.** An
 * absent message is how the table says "this route does not lose it", so there is
 * no separate flag that could disagree with the message next to it, and no way to
 * spell a route that fires with nothing to say.
 */
interface RequirementCheck {
    /** Why a resumed run no longer has it. Absent when a parked run keeps it. */
    readonly afterParking?: string;
    /** Why a trigger not declaring it never had it. Absent when none can lack it. */
    readonly fromGateway?: string;
    readonly advice: string;
}

/** Which requirement a check is about, read from the key so it cannot disagree. */
type CheckedRequirement = Exclude<FlowContextRequirement, 'subject'>;

/**
 * The requirements a graph can actually violate.
 *
 * Keyed rather than listed, for two reasons. A new member of the vocabulary
 * becomes a compile error here until someone decides what it means, where a plain
 * array would have left it silently unchecked with every test still passing. And
 * the key is the *only* place a requirement names itself — repeating it inside
 * the value would let the two disagree, and the loop would then check one
 * requirement while telling the author about another.
 *
 * `subject` is excluded in the key type rather than merely omitted: every run has
 * one, so it is documentation, and stating the exclusion in the type is the
 * difference between a deliberate choice and an oversight nobody can tell apart.
 */
const CHECKED_REQUIREMENTS: Readonly<Record<CheckedRequirement, RequirementCheck>> = {
    interaction: {
        // Gone the moment a run parks: the token expires, and no resume path
        // rebuilds one.
        afterParking: 'it can be reached after a block that parks the run, and a resumed run has no interaction',
        // A gateway trigger never had one to begin with.
        fromGateway: 'it can be reached from a trigger that fires on a gateway event, which has no interaction',
        advice: 'Move it before the wait, or start this path from a button.',
    },
    actor: {
        // Nobody causes a resumed step — the clock does.
        afterParking:
            'it can be reached after a block that parks the run, and a run woken by the clock has nobody acting on it',
        // A gateway event still has someone who caused it: the member who joined
        // or reacted. So unlike an interaction, this survives a gateway start, and
        // the absent message is what says so.
        advice: 'Move it before the wait.',
    },
    channel: {
        // No `afterParking` message, and its absence is load-bearing: the snapshot
        // persists `channelId` and `rebuildResumeContext` resolves it, so parking
        // no longer costs a run its channel.
        //
        // **`fromGateway` still does real work.** Parking *preserves* a channel;
        // it does not create one, so a run that never had one still cannot answer
        // — which is why a member join is caught by that arm alone.
        //
        // A member join happens nowhere in particular.
        fromGateway:
            'it can be reached from a trigger that fires on a gateway event, which happens in no particular channel',
        advice: 'Start this path from a button or a reaction, which both happen somewhere.',
    },
};

/**
 * Reject a block that needs something from the run context but can only ever be
 * reached without it.
 *
 * The question is the same for every checkable requirement: does some path reach
 * this node that cannot supply the thing? Two such paths exist — a resumed one,
 * which has lost whatever the original event carried, and one rooted in a trigger
 * that never had it. Which of those two loses which requirement is
 * {@link CHECKED_REQUIREMENTS}' job to say.
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

    // A trigger that does not itself declare the requirement cannot supply it, so
    // everything it reaches is suspect for the same reason a resumed path is.
    // Computed per requirement, because "gateway" is not one set of triggers: a
    // member join supplies an actor but no channel, and a reaction supplies both.
    const reachableFromTriggersWithout = (requirement: FlowContextRequirement): Set<string> =>
        walkFrom(
            graph.nodes
                .filter((node) => {
                    const block = getBlockDefinition(node.type);
                    return block?.kind === 'trigger' && !block.requires.includes(requirement);
                })
                .map((node) => node.id)
        );

    const errors: string[] = [];
    const entries = Object.entries(CHECKED_REQUIREMENTS) as [CheckedRequirement, RequirementCheck][];
    for (const [requirement, checked] of entries) {
        // A message present is what says this route can lose the requirement, so
        // the walk is skipped entirely when there is nothing it could report.
        const fromGatewayReachable = checked.fromGateway
            ? reachableFromTriggersWithout(requirement)
            : new Set<string>();

        for (const node of graph.nodes) {
            const block = getBlockDefinition(node.type);
            if (!block?.requires.includes(requirement)) {
                continue;
            }
            // A trigger declaring a requirement supplies its own.
            if (block.kind === 'trigger' || !reachableAtAll.has(node.id)) {
                continue;
            }

            // Parking is reported in preference to a gateway start when both
            // apply: it is the more specific fact, and the one an author can act
            // on without changing how the flow starts.
            const absentAfterParking = Boolean(checked.afterParking) && afterParking.has(node.id);
            const because = absentAfterParking
                ? checked.afterParking
                : fromGatewayReachable.has(node.id)
                  ? checked.fromGateway
                  : undefined;
            if (!because) {
                continue;
            }
            errors.push(
                `Node ${node.id} (${node.type}) needs "${requirement}" from the run, but ${because}. ` +
                    checked.advice
            );
        }
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
