import type { FlowGraph } from '../data/flowGraph';
import type { FlowValidationIssue } from '../engine/nodeDataValidation';
import { collectResourceTargets } from './resourceTargets';

export interface PendingResourceFields {
    /**
     * Config keys the save-time schema check may find empty, per node.
     *
     * Ready to hand to `validateNodeData`'s `pendingFields`, which is the whole
     * point of this shape: the engine is told *which fields are filled in later*
     * and never learns why, so it stays a general interpreter that knows nothing
     * about provisioning.
     */
    readonly pendingFields: ReadonlyMap<string, ReadonlySet<string>>;
    /**
     * Sidecars naming a resource the flow does not declare.
     *
     * A bug class the previous check could not express at all: before pairs were
     * validated, `channelIdKey: 'typo-channel'` with an empty `channelId` looked
     * exactly like `channelIdKey: 'qa-channel'`, and the difference only surfaced
     * as a run that failed against a channel nobody ever declared.
     */
    readonly issues: readonly FlowValidationIssue[];
}

/**
 * Decide which picker fields are allowed to be empty, and blame the ones that are not.
 *
 * A picked resource is stored as a **pair**: `channelId` holds the snowflake and
 * `channelIdKey` records which declaration it came from. Choosing a declared
 * resource deliberately clears the snowflake, because it genuinely does not exist
 * until install and a stale one would look valid to the executor. The two halves of
 * that design were written independently of the save-time schema check, which knew
 * only that `channelId` must be non-empty — so a correctly-authored flow could not
 * be saved at all.
 *
 * The rule this restores is about the **pair**, not about either half:
 *
 *  - empty value + sidecar naming a **declared** key → fine, it arrives at install
 *  - empty value + sidecar naming an **undeclared** key → an error naming the key
 *  - empty value + **no** sidecar → untouched; the original rule still refuses it
 *
 * That third line is why the schemas were not simply relaxed to `.optional()`. A
 * node with no channel picked at all is still a broken node, and the emptiness is
 * only acceptable because something else is on the hook for the value.
 *
 * **A sidecar over a filled-in value is never an error**, whether or not the key is
 * still declared. Install writes the snowflake and deliberately leaves the sidecar
 * behind — that is what makes a deleted-and-recreated channel repairable by
 * re-installing rather than by editing every flow that referenced it. Blaming an
 * undeclared key there would refuse to save a flow that runs perfectly well, purely
 * because somebody tidied the Resources list after installing. Only an empty value
 * actually depends on the declaration, so only an empty value is judged against it.
 *
 * Derived from the graph rather than from block declarations, exactly as
 * {@link collectResourceTargets} is, so a block that grows an eighth picker field
 * is covered without editing this file.
 *
 * @param graph - The graph being saved.
 * @param declaredKeys - Resource keys this flow declares. Empty for a flow that
 * does not exist yet: it can have declared nothing, so every sidecar in it names
 * something undeclared, which is the correct answer rather than a shortcut.
 */
export function pendingResourceFields(
    graph: FlowGraph,
    declaredKeys: ReadonlySet<string>
): PendingResourceFields {
    const pendingFields = new Map<string, Set<string>>();
    const issues: FlowValidationIssue[] = [];

    const nodesById = new Map(graph.nodes.map((node) => [node.id, node]));

    const markPending = (nodeId: string, configKey: string): void => {
        const existing = pendingFields.get(nodeId);
        if (existing) existing.add(configKey);
        else pendingFields.set(nodeId, new Set([configKey]));
    };

    for (const target of collectResourceTargets(graph)) {
        if (declaredKeys.has(target.resourceKey)) {
            markPending(target.nodeId, target.configKey);
            continue;
        }

        // Already resolved: the sidecar is a record of where the id came from, and
        // the node has the id. Nothing to wait for, so nothing to complain about.
        const value = nodesById.get(target.nodeId)?.data[target.configKey];
        if (value !== undefined && value !== '') {
            continue;
        }

        // Marked pending **as well as** blamed, which looks contradictory and is
        // not. The field is empty for a reason the schema cannot see, so letting
        // the schema also report "expected >= 1 character" would put two
        // complaints on one control — one of them naming the actual mistake and
        // one restating it in Zod's words. Claiming the field here is what makes
        // this the single message about it.
        //
        // It only works because the caller concatenates both lists — see
        // `validateGraphForSave` in `flowRoutes.ts`. A caller that took the issues
        // and dropped them would have suppressed the schema's complaint and put
        // nothing in its place, saving a flow that cannot run.
        markPending(target.nodeId, target.configKey);
        issues.push({
            nodeId: target.nodeId,
            field: target.configKey,
            message:
                `names the resource "${target.resourceKey}", which this flow doesn't declare. ` +
                'Add it under Resources, or pick something that already exists in the server.',
        });
    }

    return { pendingFields, issues };
}
