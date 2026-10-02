import type { FlowGraph } from '../data/flowGraph';
import { authoredGraphIssues } from '../engine/graphValidation';
import { validateNodeData, type FlowValidationIssue } from '../engine/nodeDataValidation';
import { fieldCheckIssueMessage } from './fieldChecks';
import { pendingResourceFields } from './pendingResourceFields';
import { collectResourceTargets } from './resourceTargets';

/**
 * Everything standing between a structurally sound graph and a flow that may run.
 *
 * ## The three states a graph can be in
 *
 *  - **Structurally broken** — `validateFlowGraph` refuses it: a zod shape failure, a
 *    duplicate node id, an edge naming a node that is not there. The executor cannot
 *    walk it at all, so it is never stored, whoever is writing. This function is not
 *    asked about one; its parameter is a {@link FlowGraph} precisely because only a graph
 *    that passed that check has one.
 *  - **Incomplete** — sound, but this returns issues: a node whose config its block
 *    refuses, a sidecar naming a resource the flow does not declare, or an authoring
 *    rule broken (fan-out on a handle, a question with nothing wired after it, a token
 *    no run can fill in). Storable, because refusing it is how operators lost work —
 *    but never live: it cannot be switched on or deployed, and a save of one onto a flow
 *    that is on is kept as the saver's draft instead.
 *  - **Ready** — returns nothing. Authored completely; may go live once installed.
 *
 * **"Ready" does not mean "installed".** A picker field left empty because it names a
 * resource the flow declares but has not installed yet is ready by this definition —
 * that is what `declaredKeys` is for — so it is not counted here, and does not raise the
 * flows list's "Needs fixes" chip: the install chip beside it already says so, and one
 * fact shown twice on a row is a chip that has not earned its place. It is refused
 * separately, and later: switching on needs {@link uninstalledResourceKeys} to be empty
 * too, and deploy names what to install (`planButtonDeployment`). Without that, a
 * member-join or reaction flow switched on before its install would start runs that
 * fail on the empty snowflake.
 *
 * ## What is checked, and in what order
 *
 * Node data first, then the authoring rules, so an unknown block type is reported as
 * an unknown type rather than only as complaints about handles on a block nobody
 * recognises. **Both halves always run**, which is a change from when this was the
 * save refusal and stopped at the first stage that failed. That was about which single
 * complaint to show; now the list becomes a count an operator reads off the flows list
 * and the enable gate, and "1 problem" that turns into three the moment it is fixed is
 * a count that lied. It is safe because none of the authoring rules assumes valid node
 * data: every one reads block declarations, and the one that reads `data` at all
 * (unknown copy tokens) type-checks each value before touching it and skips unknown
 * block types.
 *
 * `declaredKeys` is what lets a picker field be empty: a node that picked a resource
 * this flow declares but has not installed holds an empty snowflake and a sidecar
 * naming the declaration. {@link pendingResourceFields} translates the declaration into
 * the engine's own vocabulary — "these fields are filled in later" — so the validator
 * stays a general check that has never heard of provisioning.
 *
 * Issues, not a joined string, and every one names its node — which is what the builder
 * marks the card with, and the only place an operator can find a problem on a canvas.
 *
 * Needs the block registry, so a caller must have awaited discovery.
 *
 * @param graph - A graph that has already passed `validateFlowGraph`.
 * @param declaredKeys - Resource keys this flow declares. Empty for a flow with no
 * journey — or one that does not exist yet, which can have declared nothing.
 */
export function flowReadinessIssues(
    graph: FlowGraph,
    declaredKeys: ReadonlySet<string>
): readonly FlowValidationIssue[] {
    const pending = pendingResourceFields(graph, declaredKeys);
    const nodeData = validateNodeData(graph, {
        pendingFields: pending.pendingFields,
        // Worded as the builder words the same rule while the author types.
        issueMessage: fieldCheckIssueMessage,
    });

    return [
        // Together: a sidecar naming nothing and a field the schema refuses are the
        // same author's same mistake seen from two sides. The pending list has to be
        // here whenever its fields were marked pending, or the schema's complaint
        // about them would have been suppressed with nothing in its place.
        ...pending.issues,
        ...(nodeData.valid ? [] : nodeData.issues),
        ...authoredGraphIssues(graph),
    ];
}

/**
 * The declared resources a graph is still waiting on: every resource key a picker field
 * names through its sidecar, where the flow declares that key **and** the field is still
 * empty. Deduplicated, in the order the graph first names them.
 *
 * What stands between a *ready* flow and one that may be switched on. Empty means every
 * picked resource has arrived — including a flow that picks none.
 *
 * Not `pendingResourceFields(...).pendingFields`, which looks like the same question and
 * is not: that marks a declared sidecar pending **whether or not its value was filled
 * in**, because it answers "which empty fields may the schema forgive", and install
 * deliberately leaves the sidecar behind after writing the id. Reading it as "not
 * installed" would refuse to switch on every flow that had ever been installed.
 *
 * An undeclared key is not listed. With an empty value it is already an issue from
 * {@link flowReadinessIssues}, and with a filled one it is a record of where the id came
 * from, not something to wait for.
 */
export function uninstalledResourceKeys(
    graph: FlowGraph,
    declaredKeys: ReadonlySet<string>
): readonly string[] {
    const nodesById = new Map(graph.nodes.map((node) => [node.id, node]));
    const waiting = new Set<string>();

    for (const target of collectResourceTargets(graph)) {
        if (!declaredKeys.has(target.resourceKey)) continue;
        const value = nodesById.get(target.nodeId)?.data[target.configKey];
        if (value === undefined || value === '') {
            waiting.add(target.resourceKey);
        }
    }

    return [...waiting];
}

/**
 * The sentence a switch-on is refused with while {@link uninstalledResourceKeys} is not
 * empty. Its own sentence rather than a readiness count, because nothing on the canvas
 * is wrong: the fix is the Install button, not an edit.
 */
export function installBeforeEnablingMessage(keys: readonly string[]): string {
    const named = keys.map((key) => `"${key}"`).join(', ');
    return (
        "Install this flow's resources before turning it on — " +
        `${named} ${keys.length === 1 ? "isn't" : "aren't"} in the server yet.`
    );
}

/**
 * "1 problem", "3 problems" — the count every server-side readiness refusal leads with,
 * so the route, the deploy refusal and the enable gate cannot come to count differently.
 */
export function problemCount(count: number): string {
    return `${count} ${count === 1 ? 'problem' : 'problems'}`;
}
