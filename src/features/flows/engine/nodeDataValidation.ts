import type { z } from 'zod';
import type { FlowGraph } from '../data/flowGraph';
import { getBlockDefinition } from '../blocks/registry';

/**
 * One thing wrong with a graph, addressed to the thing that is wrong.
 *
 * `nodeId` and `field` are what the builder needs to put the complaint next to the
 * control that caused it. Both are optional because not every problem has them: a
 * graph-wide rule blames no node, and an unknown block type blames no field.
 *
 * `message` is always present and always readable on its own, so a caller that
 * only has room for a sentence loses placement rather than meaning.
 */
export interface FlowValidationIssue {
    readonly nodeId?: string;
    /** Dotted path into the node's config, e.g. `fields.0.name`. */
    readonly field?: string;
    readonly message: string;
}

export type NodeDataValidationResult =
    | { valid: true }
    | { valid: false; issues: readonly FlowValidationIssue[] };

export interface NodeDataValidationOptions {
    /**
     * Config keys whose value something else supplies later, per node.
     *
     * A field named here is allowed to be **empty or absent** — and nothing more.
     * Every other complaint about it still stands, including a value of the wrong
     * type, because "filled in later" says when the value arrives, not that any
     * value will do.
     *
     * The caller decides what earns a place in here; this file deliberately does
     * not know. That keeps the rule one sentence ("this field is filled in later")
     * rather than a second copy of whatever convention produced it.
     *
     * **Nested by node rather than flattened into `"<nodeId>.<field>"` keys.** The
     * flat spelling was the first shape and was wrong: a node id is free-form
     * (`flowGraph.ts` asks only for a non-empty string), so an id containing a dot
     * can spell the same key as a different node's *nested* config path —
     * `'embed.fields.0'` + `'name'` collides with `'embed'` + `'fields.0.name'` —
     * and the collision silently suppresses a genuine issue. Two levels have no
     * separator to collide on.
     */
    readonly pendingFields?: ReadonlyMap<string, ReadonlySet<string>>;
}

/**
 * Validate every node's `data` against its registry `configSchema`.
 *
 * {@link validateFlowGraph} only checks the graph's *shape* (ids, edges) —
 * `data` is an opaque record there. This is the second half: an unknown node
 * `type` or a `data` payload its node type rejects is an error, so a graph that
 * would fail at execution time is refused at save time instead.
 *
 * ## Emptiness is conditional, everything else is not
 *
 * A field in `pendingFields` may be empty. That is the whole of the exemption:
 * the value is still parsed, still has to be a string if the schema says string,
 * and every other rule the schema states still applies. Relaxing the schema
 * itself to `.optional()` would have been the smaller edit and the wrong one — it
 * would let a node with nothing filled in at all save clean, when the emptiness
 * is only tolerable *because* the caller has vouched that something supplies the
 * value before the node ever runs.
 *
 * Nothing here relaxes **execution**. The executor re-parses `configSchema`
 * before running a node and fails the run, logged, when it does not parse — so a
 * graph saved with a field still empty refuses to run rather than running against
 * nothing. Save is the only thing this widens.
 */
export function validateNodeData(
    graph: FlowGraph,
    options: NodeDataValidationOptions = {}
): NodeDataValidationResult {
    const issues: FlowValidationIssue[] = [];

    for (const node of graph.nodes) {
        const definition = getBlockDefinition(node.type);
        if (!definition) {
            issues.push({ nodeId: node.id, message: `unknown node type "${node.type}"` });
            continue;
        }

        const parsed = definition.configSchema.safeParse(node.data);
        if (parsed.success) {
            continue;
        }

        const pending = options.pendingFields?.get(node.id);

        for (const issue of parsed.error.issues) {
            const field = issue.path.join('.');
            if (pending && isPending(pending, issue, node.data)) {
                continue;
            }
            issues.push({ nodeId: node.id, field: field || undefined, message: issue.message });
        }
    }

    return issues.length > 0 ? { valid: false, issues } : { valid: true };
}

/**
 * May this one complaint be skipped because something fills the field in later?
 *
 * **Only a top-level config key can be pending**, which is why the path length is
 * checked rather than the joined string. A nested path like `fields.0.name` names a
 * value inside a list entry, and `data['fields.0.name']` is always `undefined` — so
 * reading it would take the "absent" branch below without ever seeing the value the
 * branch exists to judge. The exemption is about a key the node holds; a key it does
 * not hold is not a case this understands, and silently guessing would be worse than
 * reporting the issue.
 */
function isPending(
    pending: ReadonlySet<string>,
    issue: z.core.$ZodIssue,
    data: Record<string, unknown>
): boolean {
    if (issue.path.length !== 1) {
        return false;
    }

    const field = String(issue.path[0]);
    return pending.has(field) && isEmptyValue(issue.code, data[field]);
}

/**
 * Is this complaint "there is nothing here", as opposed to "what is here is wrong"?
 *
 * Both halves are checked, and both are load-bearing. The **code** alone would
 * forgive `z.string().min(2)` complaining about a one-character value, which is a
 * real mistake rather than a value still to arrive. The **value** alone would
 * forgive any rule at all so long as the field happened to read empty — including
 * a schema that genuinely rejects the empty string for its own reasons.
 *
 * `invalid_type` is admitted for an absent value because a config can lose a key
 * outright — an editor that removes a field rather than blanking it, or a graph
 * written before the field existed — and that is the same "nothing here yet" this
 * exemption is about. A present value of the wrong type is not: `42` is not
 * pending, it is wrong, and it fails.
 *
 * `code` is Zod's own literal union rather than `string`, deliberately. Every
 * unrecognised code here **fails closed** — the issue is reported — so a Zod rename
 * would not admit anything wrong, it would quietly stop admitting the one thing it
 * should and restore the original bug with a green suite. Typing it turns that into
 * a build error. (v3→v4 already renamed `invalid_string` to `invalid_format`, so
 * this is a rename that happens rather than one that might.)
 */
function isEmptyValue(code: z.core.$ZodIssue['code'], value: unknown): boolean {
    if (value === undefined) {
        return code === 'invalid_type';
    }
    return code === 'too_small' && value === '';
}

/** Render an issue the way a log line or a single-sentence client wants it. */
export function describeIssue(issue: FlowValidationIssue): string {
    const where = [issue.nodeId, issue.field].filter(Boolean).join(': ');
    return where ? `${where}: ${issue.message}` : issue.message;
}
