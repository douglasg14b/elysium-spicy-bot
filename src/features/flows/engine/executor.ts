import { randomUUID } from 'crypto';
import { FLOW_MAX_NODE_VISITS, FLOW_MAX_VARIABLES_SIZE } from '../constants';
import type { FlowEdge, FlowGraph, FlowNode } from '../data/flowGraph';
import { flowRunsRepo } from '../data/flowRunsRepo';
import type { BlockKind, BlockManifest } from '../blocks/manifest';
import { getBlockDefinition } from '../blocks/registry';
import type {
    FlowResume,
    FlowResumeReason,
    FlowRunContext,
    FlowRunSeed,
    FlowVariableValue,
} from '../blocks/types';
import { isCopyField, renderCopy } from './copyRendering';
import type { FlowStepOutcome, FlowStepSuspension } from './stepOutcome';
import { releaseWaitMessageControls } from './waitMessageControls';

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
    /**
     * Values blocks have recorded so far, carried across the park.
     *
     * On the suspension rather than left in memory because the run may not wake
     * in this process, or this week: a bag that lived only in the executor would
     * be empty on every resumed run, and a block reading `{{var.x}}` after a wait
     * would fail for a reason no author could see. This is the serialisable half
     * of the write channel — the writer itself is not run state, the bag it
     * drains into is.
     */
    variables: Record<string, FlowVariableValue>;
}

/**
 * The result of running one *segment* of a flow: either the graph ran out (or
 * failed), or it hit a suspending node and wants to be parked.
 */
export type ExecOutcome =
    | { kind: 'completed'; result: FlowRunResult }
    | { kind: 'suspended'; suspension: FlowSuspension };

export interface ExecuteSegmentOptions {
    /**
     * The run's durable id, handed to every block as `context.runId`.
     *
     * Supplied by the caller rather than minted here, because a resumed segment
     * must carry the id of the row it came from — a fresh id would address a run
     * that does not exist. {@link executeFlow} mints one for a new run and passes
     * it to the row it later creates, so the two can never disagree.
     */
    runId: string;
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
    /**
     * Values recorded by earlier segments of this run.
     *
     * Seeded from the parked row on a resume. Omitted on a fresh run, where the
     * bag legitimately starts empty — which is why this is optional rather than
     * required-and-often-`{}`.
     */
    variables?: Readonly<Record<string, FlowVariableValue>>;
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
    context: FlowRunSeed,
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
    // Replaced wholesale rather than mutated, so the object a node was handed
    // stays the bag that node saw even after a later one writes.
    let variables: Readonly<Record<string, FlowVariableValue>> = emptyBagWith(options.variables);

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

        // Rendering reads the run and writes nothing, so it takes the seed rather
        // than a context: there is no node running yet to own a write channel.
        const rendered = renderNodeCopy(definition, parsed.data, { ...context, variables });
        if (!rendered.ok) {
            const message = `Node ${node.id} (${node.type}): ${rendered.error}`;
            log.push({ nodeId: node.id, type: node.type, kind: definition.kind, status: 'error', error: message });
            return fail(message);
        }

        const resumedHere = isWaking ? pendingResume?.reason : undefined;

        // Rebuilt for EVERY node, not only a waking one. The write channel below
        // closes over this node's identity, so handing two nodes one shared
        // context object would let the second inherit the first's writer — and
        // mutating the caller's context instead would make one block's bag
        // visible to code that never asked for it, including the caller itself.
        // `variables` is a fresh snapshot per node for the same reason: it is
        // `Readonly` to a block precisely so nobody can write through it.
        const writes = new Map<string, FlowVariableValue>();
        // The channel is open only while the node is running. A block that kicks
        // off unawaited work and writes when it later resolves would otherwise
        // drop the value into a map nothing reads again — the downstream
        // `{{var.x}}` would then fail naming a key the author can plainly see
        // their block writing, which is the least debuggable failure there is.
        //
        // A late write is **logged, never thrown**. By the time one happens the
        // executor has moved on, so nothing is left to catch it: the throw would
        // escape from whatever timer or microtask the block left running and take
        // the bot process down, which is a far worse answer to a block's bug than
        // the lost value it is complaining about.
        let acceptsWrites = true;
        const stepContext: FlowRunContext = {
            ...context,
            runId: options.runId,
            nodeId: node.id,
            variables,
            setOutput: (key, value) => {
                if (!acceptsWrites) {
                    console.error(
                        `[flows] Node ${node.id} (${node.type}) recorded "${key}" after its run had already ` +
                            'finished, so the value was not stored. Await the work that produces it before returning.'
                    );
                    return;
                }
                writes.set(key, value);
            },
            ...(resumedHere ? { resume: resumedHere } : {}),
        };
        pendingResume = undefined;

        let outcome: FlowStepOutcome;
        try {
            outcome = await definition.run(rendered.config, stepContext);
        } catch (error) {
            const message = error instanceof Error ? error.message : `Unknown ${definition.kind} error`;
            log.push({ nodeId: node.id, type: node.type, kind: definition.kind, status: 'error', error: message });
            return fail(message);
        } finally {
            acceptsWrites = false;
        }

        // Drained only once the node has returned. A block that threw leaves no
        // trace in the bag, which keeps "what a downstream block can read" the
        // same question as "what a block that completed chose to record".
        const drained = drainWrites(writes, variables);
        if (!drained.ok) {
            const message = `Node ${node.id} (${node.type}): ${drained.error}`;
            log.push({ nodeId: node.id, type: node.type, kind: definition.kind, status: 'error', error: message });
            return fail(message);
        }
        variables = drained.variables;

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
            // follow them.
            //
            // `validateAuthoredGraph` rejects this shape at save time, so a graph
            // saved since that rule exists cannot reach here. One saved *before*
            // it still can, which is why this stays.
            const outgoing = edgesBySource.get(node.id) ?? [];
            const reachable = outgoing.some((edge) =>
                definition.handles.some((handle) => (handle.id ?? undefined) === (edge.sourceHandle ?? undefined))
            );
            if (!reachable) {
                // The block may already have posted controls before parking, and
                // discarding the park means no row is ever written for them — so
                // nothing on the resume path can ever disable them, and a press
                // names a run that does not exist. Take them down here, on the one
                // path that knows both that the message exists and that nothing
                // will wake to tidy it.
                await releaseWaitMessageControls(context.channel, outcome.suspension.waitMessageId);
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
                    variables: emptyBagWith(variables),
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
              ? `Node ${node.id} (${node.type}) waited and then ${describeWaking(resumedHere)}, ` +
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
    context: FlowRunSeed,
    onSuspend?: (suspension: FlowSuspension) => Promise<void>
): Promise<FlowRunResult> {
    /*
     * Minted before the walk, not when the row is written.
     *
     * A block that posts a component a press must route back to needs to name its
     * own run while it is still running — and on a fresh run the row does not
     * exist yet, because a row is only written once something parks. Generating
     * the id here and handing the *same* one to the row closes that: the id a
     * button carries is the id the row is later created with.
     *
     * A run that never parks spends this id on nothing, which costs one UUID.
     */
    const runId = randomUUID();
    const persist = onSuspend ?? ((suspension) => persistNewSuspendedRun(flowId, runId, context, suspension));

    const outcome = await executeFlowSegment(flowId, graph, context, {
        runId,
        startNodeId: triggerNodeId,
        requireTrigger: true,
    });

    if (outcome.kind === 'completed') {
        return outcome.result;
    }

    const { suspension } = outcome;
    try {
        await persist(suspension);
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
 * parked. Only ids are snapshotted — every Discord handle is re-fetched on resume.
 *
 * The channel is recorded as an id and only when the run has one: a run started
 * by a member join is genuinely nowhere, and writing a key for it would claim
 * otherwise.
 */
async function persistNewSuspendedRun(
    flowId: string,
    runId: string,
    context: FlowRunSeed,
    suspension: FlowSuspension
): Promise<void> {
    await flowRunsRepo.create({
        // Supplied, not generated: a block that parked may already have posted a
        // component naming this id, so the row has to be the one it named.
        runId,
        flowId,
        guildId: context.guild.id,
        contextSnapshot: {
            guildId: context.guild.id,
            userId: context.subject.id,
            // Spread rather than `channelId: context.channel?.id`, so a run with no
            // channel builds an object without the key rather than one holding an
            // explicit `undefined`. The stored JSON is identical either way —
            // `JSON.stringify` drops undefined members — so this buys nothing at
            // rest. What it buys is in memory: the field is optional on
            // `FlowRunContextSnapshot`, and this is the form that matches it, so
            // `Object.hasOwn` and anything inspecting the object before it is
            // serialised sees "no channel recorded" rather than "channel recorded
            // as nothing".
            ...(context.channel ? { channelId: context.channel.id } : {}),
        },
        resumeNodeId: suspension.resumeNodeId,
        wakeAt: suspension.wakeAt ?? null,
        waitKind: suspension.waitKind ?? null,
        waitConfig: suspension.waitConfig ?? null,
        waitMessageId: suspension.waitMessageId ?? null,
        visitsUsed: suspension.visitsUsed,
        log: suspension.log,
        variables: suspension.variables,
    });
}

/**
 * A copy of a variable bag that inherits nothing.
 *
 * An ordinary spread quietly reinstates `Object.prototype`, and a bag that
 * inherits one answers `bag.toString` with a native function. `Object.hasOwn` at
 * the read sites is the primary guard; this keeps the object itself honest so a
 * future reader is not the only thing standing between a block and `toString`.
 *
 * **The executor normalizes at its own boundaries, not everywhere a bag is
 * built.** A bag entering `executeFlowSegment` is re-bagged on the way in, and
 * the one leaving on a suspension is re-bagged on the way out — so the three
 * dispatchers may seed a plain `variables: {}` and the invariant still holds for
 * every bag a block or the renderer ever sees. Anything that reads a bag
 * *without* going through the executor is the case to watch.
 *
 * Exported for the **resume** path, which is exactly that case: a bag that has
 * been through the database arrives as whatever `JSON.parse` and Zod produced,
 * which is an ordinary object again.
 */
export function emptyBagWith(
    source: Readonly<Record<string, FlowVariableValue>> | undefined
): Record<string, FlowVariableValue> {
    return Object.assign(Object.create(null) as Record<string, FlowVariableValue>, source ?? {});
}

/**
 * Fold one node's writes into the run's bag, or say why they cannot be kept.
 *
 * Returns a **new** bag: the previous one was handed to nodes that have already
 * run, and rewriting it underneath them would change what they saw after the fact.
 *
 * The cap is measured on the serialised whole rather than per value, because that
 * is what a parked row actually costs — and it is checked here, at the one place
 * the bag grows, rather than at the park, so a loop is stopped when it overruns
 * instead of on whichever iteration happens to suspend.
 */
function drainWrites(
    writes: ReadonlyMap<string, FlowVariableValue>,
    current: Readonly<Record<string, FlowVariableValue>>
): { ok: true; variables: Readonly<Record<string, FlowVariableValue>> } | { ok: false; error: string } {
    if (writes.size === 0) {
        return { ok: true, variables: current };
    }

    // A null prototype, so the bag holds only what blocks actually recorded.
    // With an ordinary object, `{{var.toString}}` resolves to a native function
    // on an *empty* bag, and `setOutput('__proto__', …)` is swallowed by the
    // setter instead of being stored. Both stop existing here rather than being
    // guarded for at every read.
    // Plain assignment is safe on a null-prototype object: there is no inherited
    // `__proto__` setter left to intercept the write.
    const merged = emptyBagWith(current);
    for (const [key, value] of writes) {
        merged[key] = value;
    }

    // Bytes, not code units: the cap is about how large a stored row gets, and an
    // emoji is one or two UTF-16 units but up to four bytes. Measuring `.length`
    // would let a bag of emoji run several times over the intended size.
    const size = Buffer.byteLength(JSON.stringify(merged), 'utf8');
    if (size > FLOW_MAX_VARIABLES_SIZE) {
        return {
            ok: false,
            error:
                `recording ${[...writes.keys()].map((key) => `"${key}"`).join(', ')} would take this run's stored ` +
                `values to ${size} bytes, over the ${FLOW_MAX_VARIABLES_SIZE} limit. A flow that keeps ` +
                'recording values in a loop will hit this; record fewer, or shorter, values.',
        };
    }

    return { ok: true, variables: merged };
}

/** A node's config with its copy fields expanded, or why they could not be. */
type RenderedConfig = { ok: true; config: unknown } | { ok: false; error: string };

/**
 * Expand the tokens in every config field a block declared as copy.
 *
 * Runs between `safeParse` and `run` on purpose. Before it, and the schema would
 * be validating a string the author never wrote; after it, and `run` would have
 * to know tokens exist. In between, the schema checks the authored template —
 * which is what save-time validation also checked — and the block receives
 * finished text.
 *
 * Fields are found by their declaration, never by name or by block type: asking
 * "which fields say they carry copy" is one rule, where asking "is this
 * action.sendMessage" would be a branch per block and a gate failure.
 */
function renderNodeCopy(block: BlockManifest, config: unknown, context: FlowRunSeed): RenderedConfig {
    const copyFields = block.configFields.filter(isCopyField);
    if (copyFields.length === 0 || config === null || typeof config !== 'object') {
        return { ok: true, config };
    }

    const source = config as Record<string, unknown>;
    let expanded: Record<string, unknown> | undefined;

    for (const field of copyFields) {
        const value = source[field.key];
        // An optional field the author left unset, or a key the schema shaped
        // into something other than a string, is simply not copy to expand.
        if (typeof value !== 'string' || !value.includes('{{')) {
            continue;
        }

        const result = renderCopy(value, {
            context,
            fieldLabel: `"${field.label}"`,
            ...(field.maxLength === undefined ? {} : { maxLength: field.maxLength }),
        });
        if (!result.ok) {
            return { ok: false, error: result.error };
        }

        // Copied lazily: a node whose copy contains no token keeps the exact
        // object the schema produced, so the overwhelmingly common case adds
        // nothing at all.
        expanded ??= { ...source };
        expanded[field.key] = result.text;
    }

    return { ok: true, config: expanded ?? config };
}

/**
 * How a run came to be awake, for the one failure message that has to say so.
 *
 * Phrased to complete "waited and then …", and exhaustive over the resume kinds
 * so a new one cannot quietly land in a message written for the old two.
 */
function describeWaking(reason: FlowResumeReason | undefined): string {
    switch (reason?.kind) {
        case 'timeout':
            return 'timed out';
        case 'choice':
            return 'was answered';
        case 'event':
            return 'woke';
        // Only reachable if the caller asks about a node that never parked, which
        // `wokeOntoNothing` already excludes — so this says the plain thing rather
        // than inventing a cause.
        case undefined:
            return 'woke';
    }
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
