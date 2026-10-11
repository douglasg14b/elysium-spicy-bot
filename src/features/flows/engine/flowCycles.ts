import {
    isObjectValue,
    parseNodeConfig,
    type BlockEmission,
    type BlockEmissionValue,
    type BlockManifest,
} from '../blocks/manifest';
import { getBlockDefinition } from '../blocks/registry';
import type { FlowNode } from '../data/flowGraph';
import type { FlowEntity } from '../data/flowsSchema';
import { outgoingTargets, walkFrom } from './graphValidation';

/*
 * Whether letting a flow go live would close a cycle of flows starting one another.
 *
 * The other half of loop protection: `FLOW_MAX_CHAIN_DEPTH` stops a chain at run time,
 * and this refuses one before it can run at all. Asked when a flow goes live — switched
 * on, or saved while on — by `decidePut` in `src/web/api/flowRoutes.ts` and by the seed
 * script.
 *
 * **The graph is made of trigger nodes, not whole flows.** A dispatcher starts a run at
 * one matched trigger, and the run walks from there, so a trigger T links to a trigger U
 * when an action reachable from T inside T's own flow causes what U listens for. A flow
 * whose two triggers lead down paths that never meet is not a loop, however its parts
 * would pair up flow by flow.
 *
 * **Generic by construction.** What a block causes is its manifest's `emits`, and every
 * config is read through the registry, so nothing here names a block or a source — and a
 * block declaring a new emission is checked with no edit here.
 */

/**
 * What the finder needs of a flow: which it is, what to call it, and the graph it runs.
 * A stored row satisfies it, and so does a flow not yet written.
 */
export type FlowCycleCandidate = Pick<FlowEntity, 'flowId' | 'name' | 'graph'>;

/** One link of a cycle: a flow, and the node in it whose action starts the next link's flow. */
export interface FlowCycleStep {
    readonly flowId: string;
    readonly flowName: string;
    /** The node whose action starts the next step's flow. */
    readonly emitterNodeId: string;
    /** The emitting block's manifest label, e.g. `Kick Member`. */
    readonly emitterLabel: string;
}

/** A trigger node in the flow that holds it, with its config read the way its dispatcher reads it. */
interface CycleTrigger {
    /** Who it is: the flow and the node together — see {@link triggerKey}. */
    readonly key: string;
    readonly flow: FlowCycleCandidate;
    readonly node: FlowNode;
    readonly block: BlockManifest;
    /** Its raw `node.data` parsed against its schema, or undefined when that does not parse. */
    readonly config: Readonly<Record<string, unknown>> | undefined;
}

/** A trigger's run reaching `emitter`, whose action starts the trigger keyed `target`. */
interface CycleEdge {
    readonly target: string;
    readonly emitter: FlowNode;
    readonly emitterBlock: BlockManifest;
}

/** How the search first reached a trigger: from the trigger keyed `from`, along `edge`. */
interface CycleParent {
    readonly from: string;
    readonly edge: CycleEdge;
}

/**
 * A cycle of triggered runs that passes through `flowId`, or null.
 *
 * `flows` is every flow that will be live after the write, the one being saved included
 * **exactly once**, already in its post-write shape — its new graph and name, and its
 * stored row left out, or the old graph would refuse the very edit that breaks a loop. A
 * flow handed twice, or `flowId` not handed at all, throws: either is a caller asking a
 * question this cannot answer.
 *
 * The steps run in order from the saved flow and back to it. A breadth-first search from
 * each of its triggers in turn returns the first cycle found, which is the shortest one
 * back to that trigger, so the message naming it stays short. Only cycles through
 * `flowId` count: one already live among other flows is not this save's business.
 *
 * Mirrors what runs. A listening trigger's raw `node.data` is parsed against its schema,
 * as the dispatchers parse it, and one that does not parse matches nothing — every
 * dispatcher means "parses, or matches nothing". An emitting node is parsed the way the
 * executor parses it, through `visibleNodeData`, and one that does not parse causes
 * nothing, because its run fails at that node. A node whose block is not registered (a
 * removed block in a stored flow) is neither, and is skipped rather than thrown on: one
 * stale flow must not refuse every save in its guild.
 *
 * Requires the block registry, so callers must have awaited discovery.
 */
export function findFlowCycleThrough(
    flows: readonly FlowCycleCandidate[],
    flowId: string
): readonly FlowCycleStep[] | null {
    const triggers = triggersIn(flows);
    if (!flows.some((flow) => flow.flowId === flowId)) {
        throw new Error(`findFlowCycleThrough was asked about flow ${flowId}, which it was not handed.`);
    }

    const edges = new Map([...triggers.values()].map((trigger) => [trigger.key, edgesFrom(trigger, triggers)]));
    for (const start of triggers.values()) {
        if (start.flow.flowId !== flowId) {
            continue;
        }
        const cycle = cycleFrom(start, triggers, edges);
        if (cycle) {
            return cycle;
        }
    }

    return null;
}

/**
 * The refusal naming every step of a cycle, from the saved flow and back to it — the same
 * sentence for a switch-on and for a save.
 *
 * Between flows it reads `That would make a loop between flows: "Welcome" (Kick Member)
 * starts "Goodbye" → "Goodbye" (Close Ticket) starts "Welcome" again. …`. A cycle that never
 * leaves one flow — that flow starting itself, through one trigger or several — is worded
 * as that, since "between flows" and "switch one off" would describe flows that are not in it.
 */
export function describeFlowCycle(steps: readonly FlowCycleStep[]): string {
    const parts = steps.map((step, index) => {
        const next = steps[(index + 1) % steps.length];
        return `"${step.flowName}" (${step.emitterLabel}) starts "${next.flowName}"`;
    });
    const text = `${parts.join(' → ')} again.`;

    const flowIds = new Set(steps.map((step) => step.flowId));
    return flowIds.size === 1
        ? `That would make this flow set itself off in a loop: ${text} Change it so it doesn't.`
        : `That would make a loop between flows: ${text} Change one of them, or switch one off.`;
}

/**
 * Who a trigger is: its flow **and** its node.
 *
 * Never the node id alone. The builder's ids are unique only by timing, and two flows
 * holding a `trigger-1` each are two different triggers. JSON rather than a joined string,
 * so no id containing the separator can collide with another pair.
 */
function triggerKey(flowId: string, nodeId: string): string {
    return JSON.stringify([flowId, nodeId]);
}

/** Every registered trigger node in `flows`, keyed by {@link triggerKey}. */
function triggersIn(flows: readonly FlowCycleCandidate[]): ReadonlyMap<string, CycleTrigger> {
    const triggers = new Map<string, CycleTrigger>();
    const seen = new Set<string>();

    for (const flow of flows) {
        if (seen.has(flow.flowId)) {
            throw new Error(
                `findFlowCycleThrough was handed flow ${flow.flowId} twice. Pass the saved flow once, in its ` +
                    'post-write shape, and leave its stored row out.'
            );
        }
        seen.add(flow.flowId);

        for (const node of flow.graph.nodes) {
            // An unregistered type is no trigger: skipped, never thrown on.
            const block = getBlockDefinition(node.type);
            if (block?.kind !== 'trigger') {
                continue;
            }

            // Raw, as the dispatchers parse a trigger's config — no `visibleNodeData`.
            const parsed = block.configSchema.safeParse(node.data);
            const key = triggerKey(flow.flowId, node.id);
            triggers.set(key, {
                key,
                flow,
                node,
                block,
                config: parsed.success && isObjectValue(parsed.data) ? parsed.data : undefined,
            });
        }
    }

    return triggers;
}

/**
 * Every trigger a run started at `trigger` can start in turn: through each emitting node
 * reachable from it inside its own flow, and each trigger that node's emissions start.
 */
function edgesFrom(trigger: CycleTrigger, triggers: ReadonlyMap<string, CycleTrigger>): readonly CycleEdge[] {
    const { graph } = trigger.flow;
    const reachable = walkFrom(outgoingTargets(graph), [trigger.node.id]);
    const edges: CycleEdge[] = [];

    for (const node of graph.nodes) {
        if (!reachable.has(node.id)) {
            continue;
        }
        const block = getBlockDefinition(node.type);
        if (!block || block.emits.length === 0) {
            continue;
        }
        const config = emitterConfig(block, node);
        if (!config) {
            continue;
        }

        for (const emission of block.emits) {
            for (const candidate of triggers.values()) {
                if (startsTrigger(emission, config, candidate)) {
                    edges.push({ target: candidate.key, emitter: node, emitterBlock: block });
                }
            }
        }
    }

    return edges;
}

/**
 * An emitting node's config as the executor hands it to `run` — through the same
 * `parseNodeConfig`. A node whose config does not parse fails its run there, so it causes
 * nothing: undefined.
 */
function emitterConfig(block: BlockManifest, node: FlowNode): Readonly<Record<string, unknown>> | undefined {
    const parsed = parseNodeConfig(block, node.data);
    return parsed.success && isObjectValue(parsed.data) ? parsed.data : undefined;
}

/**
 * Whether `emission`, from a node holding `config`, starts `trigger` — the match rule
 * {@link BlockManifest.emits} states.
 *
 * Every carried key must be unset on the trigger (any) or equal to what the emission
 * carries there; a value the emission does not know matches anything, and a key it does
 * not carry is not compared at all.
 */
function startsTrigger(
    emission: BlockEmission,
    config: Readonly<Record<string, unknown>>,
    trigger: CycleTrigger
): boolean {
    if (trigger.block.startedBy !== emission.startedBy) {
        return false;
    }

    // A trigger whose config does not parse matches nothing rather than everything, as
    // its dispatcher treats it.
    const wanted = trigger.config;
    if (!wanted) {
        return false;
    }

    return Object.entries(emission.carries ?? {}).every(([key, carried]) => {
        const held = wanted[key];
        if (isAbsent(held)) {
            return true;
        }
        const value = resolveValue(carried, config);
        return isAbsent(value) || held === value;
    });
}

/** What one carried value is on the emitting node: its literal, or what its field holds. */
function resolveValue(carried: BlockEmissionValue, config: Readonly<Record<string, unknown>>): unknown {
    return carried.value !== undefined ? carried.value : config[carried.fromField];
}

/**
 * Unset: on a trigger it means any, and on an emission it means unknown.
 *
 * Spelled out rather than `!value` on purpose: `0` and `false` are real values a field can
 * hold, and must compare like any other.
 */
function isAbsent(value: unknown): boolean {
    return value === undefined || value === null || value === '';
}

/**
 * The shortest cycle from `start` back to itself, breadth first, as steps from `start`.
 *
 * `parentOf` records how each trigger was first reached — the trigger before it and the
 * edge between — so the first edge leading back to `start` closes the shortest cycle and
 * the path is read back from it.
 */
function cycleFrom(
    start: CycleTrigger,
    triggers: ReadonlyMap<string, CycleTrigger>,
    edges: ReadonlyMap<string, readonly CycleEdge[]>
): readonly FlowCycleStep[] | null {
    const parentOf = new Map<string, CycleParent>();
    const queue = [start.key];

    while (queue.length > 0) {
        const current = queue.shift();
        if (current === undefined) {
            break;
        }

        for (const edge of edges.get(current) ?? []) {
            if (edge.target === start.key) {
                return cycleSteps(start.key, current, edge, parentOf, triggers);
            }
            if (parentOf.has(edge.target)) {
                continue;
            }
            parentOf.set(edge.target, { from: current, edge });
            queue.push(edge.target);
        }
    }

    return null;
}

/** The steps of a cycle closed by `edge` leaving `last`, read back through `parentOf` to `startKey`. */
function cycleSteps(
    startKey: string,
    last: string,
    edge: CycleEdge,
    parentOf: ReadonlyMap<string, CycleParent>,
    triggers: ReadonlyMap<string, CycleTrigger>
): readonly FlowCycleStep[] {
    const path: CycleParent[] = [{ from: last, edge }];
    let current = last;
    while (current !== startKey) {
        const parent = parentOf.get(current);
        if (!parent) {
            throw new Error(`The cycle search lost its way back from trigger ${current}.`);
        }
        path.unshift(parent);
        current = parent.from;
    }

    return path.map(({ from, edge: leaving }) => {
        const trigger = triggers.get(from);
        if (!trigger) {
            throw new Error(`The cycle search reached trigger ${from}, which it never collected.`);
        }
        return {
            flowId: trigger.flow.flowId,
            flowName: trigger.flow.name,
            emitterNodeId: leaving.emitter.id,
            emitterLabel: leaving.emitterBlock.label,
        };
    });
}
