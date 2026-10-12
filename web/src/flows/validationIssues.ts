/**
 * Where a save's complaints belong on screen.
 *
 * The server answers "what is wrong" as a flat list of {@link FlowValidationIssue};
 * the builder has to turn that into a red border on one card and a message under one
 * control. These are the two steps of that translation, kept out of the components
 * so both the card and the inspector read the same answer.
 *
 * The governing rule is **nothing is ever dropped**. An issue whose `field` names no
 * control the inspector drew still has to appear somewhere, or the author is told the
 * save failed and shown a clean form.
 */

import type { FlowValidationIssue } from '@brattybot/web-sdk';

/** Issues grouped by the node they blame, for the canvas and the inspector. */
export function issuesByNode(
    issues: readonly FlowValidationIssue[]
): ReadonlyMap<string, readonly FlowValidationIssue[]> {
    const byNode = new Map<string, FlowValidationIssue[]>();

    for (const issue of issues) {
        if (!issue.nodeId) continue;
        const existing = byNode.get(issue.nodeId);
        if (existing) existing.push(issue);
        else byNode.set(issue.nodeId, [issue]);
    }

    return byNode;
}

/**
 * What is wrong with the canvas as the author sees it now: the server's last answer,
 * with the fields edited since replaced by what the browser can tell about them live.
 *
 * The one rule both the cards and the inspector read, so the two cannot disagree. An
 * edited field's server complaint describes a value that is gone, so it is dropped —
 * that is what lets a mark clear on the first keystroke — and the live check speaks for
 * the field instead, until the server is next asked. Every field not edited keeps the
 * server's word, so fixing one problem never hides another.
 *
 * Editing a list field drops its entries' complaints too (`options.0`): they are
 * addressed below the field, and describe the list as it was.
 *
 * @param edited - Field keys per node id, edited since the server last answered.
 * @param live - Complaints about exactly those fields, from `liveFieldIssues`.
 */
export function visibleIssues(
    server: readonly FlowValidationIssue[],
    edited: ReadonlyMap<string, ReadonlySet<string>>,
    live: readonly FlowValidationIssue[]
): readonly FlowValidationIssue[] {
    if (edited.size === 0) return server;

    const stillStanding = server.filter((issue) => {
        const fields = issue.nodeId ? edited.get(issue.nodeId) : undefined;
        if (!fields || !issue.field) return true;
        const topLevel = issue.field.split('.')[0] ?? issue.field;
        return !fields.has(topLevel);
    });
    return [...stillStanding, ...live];
}

export interface PlacedIssues {
    /** One message per field key, ready to hand a control as its `error`. */
    readonly byField: ReadonlyMap<string, string>;
    /**
     * Everything that could not be placed under a control.
     *
     * Three kinds end up here, and lumping them together is deliberate — the author
     * needs to read all of them and the distinction is ours, not theirs:
     * issues with no `field` at all (an unknown block type), issues on a **dotted**
     * path naming something inside a list entry (`fields.0.name`, which no single
     * control owns), and issues naming a field this block does not declare, which is
     * what a config key left behind by an older build looks like.
     */
    readonly nodeLevel: readonly FlowValidationIssue[];
}

/**
 * Split one node's issues into the ones a control can show and the ones it cannot.
 *
 * @param issues - Every issue blaming this node.
 * @param fieldKeys - The config fields the inspector is actually drawing. An issue
 * naming anything else cannot be placed, and saying so requires knowing this — which
 * is why it is a parameter rather than something inferred from the path.
 */
export function placeIssues(
    issues: readonly FlowValidationIssue[],
    fieldKeys: readonly string[]
): PlacedIssues {
    const drawn = new Set(fieldKeys);
    const byField = new Map<string, string>();
    const nodeLevel: FlowValidationIssue[] = [];

    for (const issue of issues) {
        if (issue.field && drawn.has(issue.field)) {
            const existing = byField.get(issue.field);
            // Joined rather than replaced: two rules can fail on one field, and
            // keeping only one of them would have the author fix it and be refused
            // again for the reason they were never shown.
            byField.set(issue.field, existing ? `${existing} ${issue.message}` : issue.message);
            continue;
        }
        nodeLevel.push(issue);
    }

    return { byField, nodeLevel };
}

/**
 * An issue as one readable line, naming its field when a control is not showing it.
 *
 * Used only for the node-level list, where the message has lost the context a
 * control's label would have given it — `fields.0.name` is the author's only clue
 * about which of six embed fields is too long.
 */
export function describeUnplacedIssue(issue: FlowValidationIssue): string {
    return issue.field ? `${issue.field}: ${issue.message}` : issue.message;
}

/**
 * "1 problem", "3 problems" — how the dashboard counts what stands between a flow and
 * going live: the save notice, the switch's tooltip, the "Needs fixes" chip.
 *
 * The server counts its own refusals with its twin in `logic/flowReadiness.ts`; the two
 * cannot share code across the workspace boundary. The card's "one problem to fix" is
 * prose rather than a count, and stays its own.
 */
export function problemCount(count: number): string {
    return `${count} ${count === 1 ? 'problem' : 'problems'}`;
}

/**
 * The one line a notification has room for.
 *
 * Says how much is wrong and where, rather than quoting one message — the messages
 * are on the cards and in the inspector now, and a toast repeating the first of them
 * would read as if it were the only one. The count of *blocks* is what tells an
 * author whether this is one bad field or a graph-wide problem.
 */
export function summarizeIssues(issues: readonly FlowValidationIssue[]): string {
    const blocks = issuesByNode(issues).size;
    const problems = problemCount(issues.length);

    if (blocks === 0) {
        // Nothing named a node: a whole-graph complaint, where there is no card to
        // point at and the message itself is all there is to go on.
        return issues.map((issue) => issue.message).join(' ');
    }

    const marked = `${problems} across ${blocks} ${blocks === 1 ? 'block' : 'blocks'}. They're marked on the canvas.`;

    // A mixed set: some issues are on cards, some are about the graph itself and are
    // on no card at all. Saying only "marked on the canvas" would send the author
    // looking for a red block that does not exist, so the homeless ones are spelled
    // out. Only a structural refusal blames no node today, and it never arrives mixed
    // with readiness issues — but "nothing is ever dropped" should hold here rather
    // than depending on a property of a different file.
    const graphWide = issues.filter((issue) => !issue.nodeId).map((issue) => issue.message);
    return graphWide.length > 0 ? `${marked} Also: ${graphWide.join(' ')}` : marked;
}
