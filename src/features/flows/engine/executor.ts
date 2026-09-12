import { FLOW_MAX_NODE_VISITS } from '../constants';
import type { FlowEdge, FlowGraph, FlowNode } from '../data/flowGraph';
import { flowRunsRepo } from '../data/flowRunsRepo';
import type { FlowRunWaitConfig } from '../data/flowRunsSchema';
import { ACTION_DELAY, delayConfigSchema } from '../nodes/actionDelay';
import {
    ACTION_WAIT_FOR_EVENT,
    WAIT_TIMEOUT_HANDLE,
    waitForEventConfigSchema,
} from '../nodes/actionWaitForEvent';
import { getNodeDefinition, isActionNode, isConditionNode, isTriggerNode } from '../nodes/registry';
import type { FlowRunContext } from '../nodes/types';

export interface NodeRunLog {
    nodeId: string;
    type: string;
    kind: 'trigger' | 'condition' | 'action';
    status: 'ok' | 'error';
    /** For condition nodes, which handle was followed. */
    branch?: 'true' | 'false';
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

/** Why a segment stopped short of finishing the graph. */
export interface FlowSuspension {
    /** The node the run should resume AT when it wakes. */
    resumeNodeId: string;
    /** When the run becomes due (a delay, or a wait's timeout). */
    wakeAt?: Date;
    /** Set when parked on an event rather than a plain delay. */
    waitKind?: FlowRunWaitConfig['eventKind'];
    waitConfig?: FlowRunWaitConfig;
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
}

/**
 * Run one segment of a flow, starting at `options.startNodeId`.
 *
 * Action nodes run in order; a condition node evaluates and follows its matching
 * output handle ('true'/'false'). Graphs may contain cycles (Phase 5), so the
 * visit budget — carried in via `options.visitsUsed` and back out on suspension
 * — is the only thing stopping a loop. A suspending node (`action.delay`,
 * `action.waitForEvent`) ends the segment with `kind: 'suspended'` instead of
 * running to the end.
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
        const startDef = getNodeDefinition(startNode.type);
        if (!startDef || !isTriggerNode(startDef)) {
            return fail(`Node ${options.startNodeId} (${startNode.type}) is not a registered trigger`);
        }
    }

    let currentNodeId: string | undefined = options.startNodeId;
    let visits = options.visitsUsed ?? 0;

    while (currentNodeId) {
        if (visits >= FLOW_MAX_NODE_VISITS) {
            return fail(`Exceeded max node visits (${FLOW_MAX_NODE_VISITS})`);
        }
        visits += 1;

        const node = nodesById.get(currentNodeId);
        if (!node) {
            return fail(`Node ${currentNodeId} not found`);
        }
        visitedNodeIds.push(node.id);

        const definition = getNodeDefinition(node.type);
        if (!definition) {
            return fail(`No registered node definition for type ${node.type}`);
        }

        // Trigger nodes are pass-through: just follow the single outgoing edge.
        if (isTriggerNode(definition)) {
            log.push({ nodeId: node.id, type: node.type, kind: 'trigger', status: 'ok' });
            currentNodeId = followEdge(edgesBySource, node.id);
            continue;
        }

        const parsed = definition.configSchema.safeParse(node.data);
        if (!parsed.success) {
            const message = `Invalid config for ${node.type}: ${parsed.error.issues
                .map((i) => i.message)
                .join(', ')}`;
            log.push({ nodeId: node.id, type: node.type, kind: definition.kind, status: 'error', error: message });
            return fail(message);
        }

        // Suspending actions are intercepted before `execute` — they park the run
        // rather than performing a side effect.
        if (node.type === ACTION_DELAY) {
            const delayConfig = delayConfigSchema.parse(node.data);
            log.push({ nodeId: node.id, type: node.type, kind: 'action', status: 'ok' });

            const resumeNodeId = followEdge(edgesBySource, node.id);
            if (!resumeNodeId) {
                // Nothing after the delay: sleeping would accomplish nothing.
                return completed(successResult(flowId, triggerNodeId, log, visitedNodeIds));
            }

            return {
                kind: 'suspended',
                suspension: {
                    resumeNodeId,
                    wakeAt: new Date(Date.now() + delayConfig.durationMs),
                    visitsUsed: visits,
                    log,
                    visitedNodeIds,
                },
            };
        }

        if (node.type === ACTION_WAIT_FOR_EVENT) {
            const waitConfig = waitForEventConfigSchema.parse(node.data);
            log.push({ nodeId: node.id, type: node.type, kind: 'action', status: 'ok' });

            // The wait node itself is the resume point: on wake we need to know
            // which handle to leave by (the plain one, or `timeout`).
            return {
                kind: 'suspended',
                suspension: {
                    resumeNodeId: node.id,
                    wakeAt:
                        waitConfig.timeoutMs === undefined
                            ? undefined
                            : new Date(Date.now() + waitConfig.timeoutMs),
                    waitKind: waitConfig.eventKind,
                    waitConfig,
                    visitsUsed: visits,
                    log,
                    visitedNodeIds,
                },
            };
        }

        if (isConditionNode(definition)) {
            try {
                const branch = await definition.evaluate(parsed.data, context);
                log.push({ nodeId: node.id, type: node.type, kind: 'condition', status: 'ok', branch });
                currentNodeId = followEdge(edgesBySource, node.id, branch);
            } catch (error) {
                const message = error instanceof Error ? error.message : 'Unknown condition error';
                log.push({ nodeId: node.id, type: node.type, kind: 'condition', status: 'error', error: message });
                return fail(message);
            }
            continue;
        }

        if (isActionNode(definition)) {
            try {
                await definition.execute(parsed.data, context);
                log.push({ nodeId: node.id, type: node.type, kind: 'action', status: 'ok' });
                currentNodeId = followEdge(edgesBySource, node.id);
            } catch (error) {
                const message = error instanceof Error ? error.message : 'Unknown action error';
                log.push({ nodeId: node.id, type: node.type, kind: 'action', status: 'error', error: message });
                return fail(message);
            }
            continue;
        }

        // Unreachable given the kind union, but keeps the loop total.
        currentNodeId = undefined;
    }

    return completed(successResult(flowId, triggerNodeId, log, visitedNodeIds));
}

/**
 * Resume a parked run **from** a `action.waitForEvent` node, leaving by the
 * given handle: the plain outgoing edge when the awaited event arrived, or the
 * `timeout` handle when the wait expired.
 *
 * Returns `null` when there is no edge to follow — for a timeout that means the
 * graph gave no timeout branch, which the caller reports as a run failure.
 */
export function resolveWaitExit(
    graph: FlowGraph,
    waitNodeId: string,
    exit: 'event' | 'timeout'
): string | null {
    const edges = graph.edges.filter((edge) => edge.source === waitNodeId);
    if (exit === 'timeout') {
        return edges.find((edge) => edge.sourceHandle === WAIT_TIMEOUT_HANDLE)?.target ?? null;
    }
    const plain = edges.find((edge) => edge.sourceHandle !== WAIT_TIMEOUT_HANDLE);
    return plain?.target ?? null;
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
        status: 'pending',
    });
}

/** Follow the outgoing edge from `nodeId`, optionally matching a source handle. */
function followEdge(
    edgesBySource: Map<string, FlowEdge[]>,
    nodeId: string,
    handle?: 'true' | 'false'
): string | undefined {
    const edges = edgesBySource.get(nodeId) ?? [];
    if (handle) {
        const match = edges.find((e) => e.sourceHandle === handle);
        return match?.target;
    }
    // No handle: take the first edge without a sourceHandle, else the first edge.
    const plain = edges.find((e) => !e.sourceHandle);
    return (plain ?? edges[0])?.target;
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
