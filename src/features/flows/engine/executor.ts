import { FLOW_MAX_NODE_VISITS } from '../constants';
import type { FlowEdge, FlowGraph, FlowNode } from '../data/flowGraph';
import { flowRunsRepo } from '../data/flowRunsRepo';
import type { BlockKind, BlockManifest } from '../blocks/manifest';
import { getBlockDefinition } from '../blocks/registry';
import type { FlowResume, FlowRunContext } from '../blocks/types';
import type { FlowStepOutcome, FlowStepSuspension } from './stepOutcome';

export interface NodeRunLog {
    nodeId: string;
    type: string;
    kind: BlockKind;
    status: 'ok' | 'error';
    /**
     * Which declared output handle the run left by, when the block named one.
     * A plain string rather than the condition vocabulary: any block may declare
     * handles, and a wait leaving by `timeout` is the same kind of fact as a
     * condition leaving by `false`.
     */
    branch?: string;
    error?: string;
}

export interface FlowRunResult {
    flowId: string;
    triggerNodeId: string;
    status: 'success' | 'error';
    visitedNodeIds: string[];
    log: NodeRunLog[];
    error?: string;
}

/**
 * Why a segment stopped short of finishing the graph.
 *
 * The parking request itself — when to wake, what to wake on — is
 * {@link FlowStepSuspension}, which is what a block declares. What this adds is
 * the executor's own bookkeeping: where to resume and what has been spent so far.
 */
export interface FlowSuspension extends FlowStepSuspension {
    /** The node the run should resume AT when it wakes. */
    resumeNodeId: string;
    /** Visit budget consumed so far — must be carried into the next segment. */
    visitsUsed: number;
    /** Log accumulated so far — must be carried into the next segment. */
    log: NodeRunLog[];
    visitedNodeIds: string[];
}

/**
 * The result of running one *segment* of a flow: either the graph ran out (or
 * failed), or it hit a suspending node and wants to be parked.
 */
export type ExecOutcome =
    | { kind: 'completed'; result: FlowRunResult }
    | { kind: 'suspended'; suspension: FlowSuspension };

export interface ExecuteSegmentOptions {
    /** Node to begin at. A trigger node on a fresh run; any node on a resume. */
    startNodeId: string;
    /**
     * Whether `startNodeId` must be a registered trigger. True for a fresh run,
     * false when resuming mid-graph.
     */
    requireTrigger?: boolean;
    /** The trigger node id, purely for reporting on a resumed segment. */
    triggerNodeId?: string;
    /** Visit budget already consumed by earlier segments of this run. */
    visitsUsed?: number;
    /** Log accumulated by earlier segments of this run. */
    log?: NodeRunLog[];
    /**
     * The node that parked this run, and why it is waking.
     *
     * Addressed to a node rather than to "whatever this segment starts at": a run
     * parked by an older build resumes at the node *after* a delay, which never
     * parked. Naming the node means such a row simply never matches and runs
     * forward normally, instead of the node it lands on being told it woke up.
     */
    resume?: FlowResume;
}

/**
 * Run one segment of a flow, starting at `options.startNodeId`.
 *
 * Every node is the same shape of work: validate its config, call its one entry
 * point, and act on the outcome it returns. Nothing here knows what any block
 * *is* — a block that parks the run does so by returning `suspend`, and the
 * segment ends with `kind: 'suspended'` because of what came back, not because
 * of which type was matched.
 *
 * Graphs may contain cycles (Phase 5), so the visit budget — carried in via
 * `options.visitsUsed` and back out on suspension — is the only thing stopping
 * a loop.
 *
 * Per-node errors are captured in the log and abort that run without crashing
 * the bot.
 */
export async function executeFlowSegment(
    flowId: string,
    graph: FlowGraph,
    context: FlowRunContext,
    options: ExecuteSegmentOptions
): Promise<ExecOutcome> {
    const log: NodeRunLog[] = [...(options.log ?? [])];
    const visitedNodeIds: string[] = [];
    const triggerNodeId = options.triggerNodeId ?? options.startNodeId;
    const completed = (result: FlowRunResult): ExecOutcome => ({ kind: 'completed', result });
    const fail = (error: string): ExecOutcome =>
        completed(failResult(flowId, triggerNodeId, log, visitedNodeIds, error));

    const nodesById = new Map<string, FlowNode>(graph.nodes.map((n) => [n.id, n]));
    const edgesBySource = new Map<string, FlowEdge[]>();
    for (const edge of graph.edges) {
        const list = edgesBySource.get(edge.source) ?? [];
        list.push(edge);
        edgesBySource.set(edge.source, list);
    }

    const startNode = nodesById.get(options.startNodeId);
    if (!startNode) {
        const label = options.requireTrigger ? 'Trigger node' : 'Resume node';
        return fail(`${label} ${options.startNodeId} not found`);
    }

    if (options.requireTrigger) {
        const startDef = getBlockDefinition(startNode.type);
        if (!startDef || startDef.kind !== 'trigger') {
            return fail(`Node ${options.startNodeId} (${startNode.type}) is not a registered trigger`);
        }
    }

    let currentNodeId: string | undefined = options.startNodeId;
    let visits = options.visitsUsed ?? 0;
    let pendingResume: FlowResume | undefined = options.resume;

    while (currentNodeId) {
        const node = nodesById.get(currentNodeId);
        if (!node) {
            return fail(`Node ${currentNodeId} not found`);
        }

        const definition = getBlockDefinition(node.type);
        if (!definition) {
            return fail(`No registered node definition for type ${node.type}`);
        }

        /**
         * Is this node being woken, as opposed to merely being where the run
         * picks up?
         *
         * Both halves matter. The node id alone is not enough: a run parked by an
         * older build names the node *after* a delay, which never parked, and
         * telling that node it woke would make a condition report a timeout it
         * never waited for. Only a block that can park can be waking.
         */
        const isWaking = pendingResume?.nodeId === node.id && definition.canSuspend;

        // Waking is the second half of one visit, not a new one: the node was
        // already charged when it parked, and charging it again would halve how
        // many times an authored loop containing a delay can go round.
        if (!isWaking) {
            if (visits >= FLOW_MAX_NODE_VISITS) {
                return fail(`Exceeded max node visits (${FLOW_MAX_NODE_VISITS})`);
            }
            visits += 1;
        }

        visitedNodeIds.push(node.id);

        const parsed = definition.configSchema.safeParse(node.data);
        if (!parsed.success) {
            const message = `Invalid config for ${node.type}: ${parsed.error.issues
                .map((issue) => issue.message)
                .join(', ')}`;
            log.push({ nodeId: node.id, type: node.type, kind: definition.kind, status: 'error', error: message });
            return fail(message);
        }

        const resumedHere = isWaking ? pendingResume?.reason : undefined;
        const stepContext: FlowRunContext = resumedHere ? { ...context, resume: resumedHere } : context;
        pendingResume = undefined;

        let outcome: FlowStepOutcome;
        try {
            outcome = await definition.run(parsed.data, stepContext);
        } catch (error) {
            const message = error instanceof Error ? error.message : `Unknown ${definition.kind} error`;
            log.push({ nodeId: node.id, type: node.type, kind: definition.kind, status: 'error', error: message });
            return fail(message);
        }

        if (outcome.kind === 'fail') {
            log.push({
                nodeId: node.id,
                type: node.type,
                kind: definition.kind,
                status: 'error',
                error: outcome.error,
            });
            return fail(outcome.error);
        }

        if (outcome.kind === 'suspend') {
            log.push({ nodeId: node.id, type: node.type, kind: definition.kind, status: 'ok' });

            // Parking is only worth the row if there is somewhere to go afterwards.
            // A block with nothing wired to any handle it actually declares would
            // wake, find the graph over, and complete — so complete now rather
            // than holding a run open to reach the same end later. Edges on
            // handles the block does not declare do not count: nothing could
            // follow them, which is what save-time validation now rejects.
            const outgoing = edgesBySource.get(node.id) ?? [];
            const reachable = outgoing.some((edge) =>
                definition.handles.some((handle) => (handle.id ?? undefined) === (edge.sourceHandle ?? undefined))
            );
            if (!reachable) {
                return completed(successResult(flowId, triggerNodeId, log, visitedNodeIds));
            }

            return {
                kind: 'suspended',
                suspension: {
                    ...outcome.suspension,
                    // The block parks at its own node: it is re-entered on wake and
                    // told why, which is how it picks its exit without the executor
                    // knowing which block it is.
                    resumeNodeId: node.id,
                    visitsUsed: visits,
                    log,
                    visitedNodeIds,
                },
            };
        }

        const next = resolveNextNode(edgesBySource, node, definition, outcome.handle);

        // A run that parked, woke, and then found its chosen branch wired to
        // nothing has not finished — it stopped having done none of what it
        // waited for. An ordinary dead end is how an author ends a path; this one
        // is a gap in the graph, and saying so is the difference between a flow
        // that quietly does nothing and one an author can fix.
        const wokeOntoNothing = Boolean(resumedHere) && outcome.handle !== undefined && next.ok && !next.target;

        const failure = !next.ok
            ? next.error
            : wokeOntoNothing
              ? `Node ${node.id} (${node.type}) waited and then ${resumedHere === 'timeout' ? 'timed out' : 'woke'}, ` +
                `leaving by its "${outcome.handle}" output — but the flow has no "${outcome.handle}" branch to follow.`
              : undefined;

        // One row per visit: a node that failed logs the failure, not a success
        // followed by a contradiction.
        log.push({
            nodeId: node.id,
            type: node.type,
            kind: definition.kind,
            ...(failure === undefined
                ? { status: 'ok', ...(outcome.handle === undefined ? {} : { branch: outcome.handle }) }
                : { status: 'error', error: failure }),
        });

        if (failure !== undefined) {
            return fail(failure);
        }

        currentNodeId = next.ok ? next.target : undefined;
    }

    return completed(successResult(flowId, triggerNodeId, log, visitedNodeIds));
}

/**
 * Walk the graph starting at `triggerNodeId`, returning once the run finishes,
 * fails, or suspends. Unchanged signature and behaviour for the dispatchers that
 * call it — a flow with no delay/wait node never touches the database.
 *
 * When the run *does* park on a suspending node, this thin wrapper persists a
 * `flow_runs` row (via `onSuspend`, which defaults to {@link flowRunsRepo}) and
 * reports `success` for the segment that ran; durable resumption is then the
 * poller's or a dispatcher's job. See {@link executeFlowSegment} for the fuller
 * API used by the resume path.
 */
export async function executeFlow(
    flowId: string,
    graph: FlowGraph,
    triggerNodeId: string,
    context: FlowRunContext,
    onSuspend: (suspension: FlowSuspension) => Promise<void> = (suspension) =>
        persistNewSuspendedRun(flowId, context, suspension)
): Promise<FlowRunResult> {
    const outcome = await executeFlowSegment(flowId, graph, context, {
        startNodeId: triggerNodeId,
        requireTrigger: true,
    });

    if (outcome.kind === 'completed') {
        return outcome.result;
    }

    const { suspension } = outcome;
    try {
        await onSuspend(suspension);
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown suspension-persistence error';
        return failResult(
            flowId,
            triggerNodeId,
            suspension.log,
            suspension.visitedNodeIds,
            `Could not persist suspended run: ${message}`
        );
    }

    console.log(
        `[flows] Flow ${flowId} suspended (trigger ${triggerNodeId}); will resume at node ${suspension.resumeNodeId}`
    );

    return {
        flowId,
        triggerNodeId,
        status: 'success',
        visitedNodeIds: suspension.visitedNodeIds,
        log: suspension.log,
    };
}

/**
 * Default `onSuspend`: insert a fresh `flow_runs` row for a run that has just
 * parked. Only `{ guildId, userId }` is snapshotted — everything else is
 * re-fetched on resume.
 */
async function persistNewSuspendedRun(
    flowId: string,
    context: FlowRunContext,
    suspension: FlowSuspension
): Promise<void> {
    await flowRunsRepo.create({
        flowId,
        guildId: context.guild.id,
        contextSnapshot: { guildId: context.guild.id, userId: context.user.id },
        resumeNodeId: suspension.resumeNodeId,
        wakeAt: suspension.wakeAt ?? null,
        waitKind: suspension.waitKind ?? null,
        waitConfig: suspension.waitConfig ?? null,
        visitsUsed: suspension.visitsUsed,
        log: suspension.log,
    });
}

/** Where the run goes next, or why it cannot be decided. */
type NextNode = { ok: true; target: string | undefined } | { ok: false; error: string };

/**
 * Follow the edge leaving `node` by the handle the block named.
 *
 * Two outgoing edges on the same handle is a **named failure**, not a silent
 * first-match. Save-time validation rejects that graph, so reaching it here means
 * the graph predates the check or was written around it — and quietly picking one
 * of two branches is how a run does something its author never asked for.
 *
 * An exit leading nowhere is not an error here, whichever handle it is: an
 * author ends a path by wiring nothing after it, and a condition whose `false`
 * side is deliberately empty is an ordinary flow. The one case the caller does
 * treat as a failure is a run that *parked* and woke onto an empty branch, which
 * it can tell because it knows the node was being resumed.
 */
function resolveNextNode(
    edgesBySource: Map<string, FlowEdge[]>,
    node: FlowNode,
    block: BlockManifest,
    handle: string | undefined
): NextNode {
    const edges = edgesBySource.get(node.id) ?? [];
    // An unnamed handle means the block's default exit, which is the edge the
    // graph persists without a `sourceHandle`.
    const matching = edges.filter((edge) => (edge.sourceHandle ?? undefined) === handle);

    if (matching.length > 1) {
        const named = handle === undefined ? 'its default output' : `its "${handle}" output`;
        return {
            ok: false,
            error:
                `Node ${node.id} (${node.type}) has ${matching.length} edges leaving ${named}, ` +
                'so which branch the run should take is ambiguous. Remove the extra edges — a handle ' +
                'may have at most one.',
        };
    }

    const target = matching[0]?.target;

    // An author ends a path by wiring nothing, so a dead end is usually fine.
    // What is not fine is an edge sitting on a handle the block never declared:
    // save-time validation rejects those now, but a graph stored before that
    // check can still carry one, and the run ends reporting success having
    // skipped whatever the author actually drew. Warn, because a silent success
    // is the one failure nobody goes looking for.
    if (!target) {
        const declared = new Set(block.handles.map((candidate) => candidate.id ?? undefined));
        const stranded = edges.filter((edge) => !declared.has(edge.sourceHandle ?? undefined));
        if (stranded.length > 0) {
            const names = stranded.map((edge) => edge.sourceHandle ?? '<default>').join(', ');
            console.warn(
                `[flows] Node ${node.id} (${node.type}) has ${stranded.length} edge(s) on handle(s) it does ` +
                    `not declare: ${names}. Those branches can never run, so this path stops here. ` +
                    'Re-saving the flow will report the mismatch properly.'
            );
        }
    }

    return { ok: true, target };
}

function successResult(
    flowId: string,
    triggerNodeId: string,
    log: NodeRunLog[],
    visitedNodeIds: string[]
): FlowRunResult {
    console.log(
        `[flows] Flow ${flowId} ran to completion (trigger ${triggerNodeId}); visited ${visitedNodeIds.length} node(s)`
    );

    return {
        flowId,
        triggerNodeId,
        status: 'success',
        visitedNodeIds,
        log,
    };
}

function failResult(
    flowId: string,
    triggerNodeId: string,
    log: NodeRunLog[],
    visitedNodeIds: string[],
    error: string
): FlowRunResult {
    console.error(`[flows] Flow ${flowId} run failed (trigger ${triggerNodeId}): ${error}`);
    return {
        flowId,
        triggerNodeId,
        status: 'error',
        visitedNodeIds,
        log,
        error,
    };
}
