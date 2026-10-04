/**
 * Which exits a block asked to be warned about are left unconnected.
 *
 * An unconnected exit is **legal** — it is how an author ends a path — so this is an
 * advisory, never a save refusal, and it follows the shape of the other two canvas
 * advisories (`unreachableNodeIds`, `convergingTriggerCounts`): a pure function of the
 * live nodes and edges, computed by the page, carried onto the card, and recomputed on
 * every edit rather than returned by a save that would be stale the moment an edge moves.
 *
 * ## Only the exits that ask
 *
 * A block marks an exit `warnIfUnconnected` when its silent dead end is rarely meant —
 * a "No record" an author forgot exists. Every other exit stays quiet, a plain "No"
 * above all: "No → end" is an ordinary flow, and a warning on it would sit on most
 * cards and teach the author to stop reading amber.
 *
 * ## Only while the exit can fire
 *
 * An exit marked `{ whenFieldSet }` is warned about only while that field holds a value
 * on the node. A "Timed out" on a wait with no time limit can never be taken, and both
 * waits default to none — warning there would mark nearly every one of them.
 *
 * An exit marked `{ whenField, equals }` is warned about only while that choice holds one
 * of `equals`. Time Since's "No record" can only be reached in a rare edge case on some
 * sources — a run parked before runs recorded their start — so warning on every node
 * using one would mark a normal card amber.
 *
 * ## Why an unwired node is not marked
 *
 * A node with no outgoing edges at all is left clean, as `unreachableNodeIds` leaves an
 * edgeless node clean: it is a block dropped a second ago, the author is looking at it,
 * and listing every exit it has not wired yet says nothing they do not know. The warning
 * is for the node they *have* wired, where the forgotten exit is the one that is easy to
 * miss.
 */

import type { Edge } from '@xyflow/react';
import type { BlockOutputHandle, NodeDescriptor } from '@brattybot/web-sdk';
import { effectiveFieldValue, isFieldVisible } from './variables';

/** The fields this module needs off a canvas node. React Flow's own type is wider. */
export interface ExitWarningNode {
    readonly id: string;
    readonly data: {
        readonly descriptor: NodeDescriptor | undefined;
        /** The node's engine `data`, read for an exit that warns only when a field is set. */
        readonly config: Record<string, unknown>;
    };
}

/**
 * The labels of each node's unconnected warned exits, keyed by node id.
 *
 * A node with nothing to say is **absent** rather than present with an empty list, so a
 * caller can render nothing on `undefined`, matching `convergingTriggerCounts`. A node
 * this build cannot draw declares no exits and is never reported.
 */
export function unconnectedWarnedExits(
    nodes: readonly ExitWarningNode[],
    edges: readonly Edge[]
): ReadonlyMap<string, readonly string[]> {
    // Which handles each node has an edge leaving by. An edge with no `sourceHandle`
    // leaves by the default exit, which a declaration spells as no `id`.
    const usedHandles = new Map<string, Set<string | undefined>>();
    for (const edge of edges) {
        const handles = usedHandles.get(edge.source) ?? new Set<string | undefined>();
        handles.add(edge.sourceHandle ?? undefined);
        usedHandles.set(edge.source, handles);
    }

    const warnings = new Map<string, readonly string[]>();
    for (const node of nodes) {
        const used = usedHandles.get(node.id);
        // Unwired, so the author can see it. See the header.
        if (!used) continue;

        const descriptor = node.data.descriptor;
        if (!descriptor) continue;

        const unconnected = descriptor.handles
            .filter((handle) => !used.has(handle.id) && warnsOn(handle, descriptor, node.data.config))
            .map((handle) => handle.label);
        if (unconnected.length > 0) warnings.set(node.id, unconnected);
    }

    return warnings;
}

/**
 * Whether an exit asks to be warned about on this node, unconnected.
 *
 * A field's value is read the way every other reader of a field reads it: the stored
 * value or the declared default, through `effectiveFieldValue`, and nothing at all while
 * the field's `visibleWhen` hides it — hidden means absent to every reader. So "set" is
 * that value being present, and "equals" is it being one of the listed choices, exactly
 * as `visibleWhen` reads its sibling. A field the block does not declare never warns;
 * conformance makes that unreachable for a shipped block.
 */
function warnsOn(handle: BlockOutputHandle, descriptor: NodeDescriptor, config: Record<string, unknown>): boolean {
    const warns = handle.warnIfUnconnected;
    if (warns === undefined) return false;
    if (warns === true) return true;

    const fieldKey = 'whenFieldSet' in warns ? warns.whenFieldSet : warns.whenField;
    const field = descriptor.configFields.find((candidate) => candidate.key === fieldKey);
    if (!field || !isFieldVisible(field, descriptor.configFields, config)) return false;

    const value = effectiveFieldValue(field, config);
    return 'whenFieldSet' in warns ? value !== undefined : typeof value === 'string' && warns.equals.includes(value);
}

/**
 * The warnings worth showing for one node, given what else is already said about it.
 *
 * None behind a failure — red is the problem to fix first — and none on a node nothing
 * reaches, where an exit cannot strand a run. Applied once, by the page, before the list
 * is carried onto the node — so the card and the inspector both read the result and
 * never disagree about the same node.
 */
export function exitWarningsShown(
    unconnectedExits: readonly string[],
    state: { readonly failed: boolean; readonly unreachable: boolean }
): readonly string[] {
    return state.failed || state.unreachable ? [] : unconnectedExits;
}

/**
 * What to tell an author about one unconnected exit.
 *
 * States the consequence rather than the topology, as `describeConvergence` does: the
 * author can see the empty handle; what they may not know is what a run taking it does.
 *
 * That differs by block, so the caller passes the block's `canSuspend`. A run leaving
 * an ordinary block by an unconnected exit simply ends there. A run that parked, woke,
 * and then leaves by a named exit wired to nothing **fails** instead — the executor
 * treats it as a gap in the graph, since the run stopped having done none of what it
 * waited for. That leans on every warned exit of a parking block being named and taken
 * only on waking (a "Timed out"): conformance refuses an unnamed one, and the block
 * contract states the rest beside `warnIfUnconnected`.
 */
export function describeUnconnectedExit(label: string, canSuspend: boolean): string {
    return canSuspend
        ? `${label} isn't connected — runs that land here fail.`
        : `${label} isn't connected — runs that land here just stop.`;
}
