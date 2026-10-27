import { buttonDisplayName } from '../../provisioning/logic/messageButtons';
import type { ResourceDeclaration } from '../../provisioning/logic/resourceDeclaration';
import { isFieldVisible } from '../blocks/manifest';
import { getBlockDefinition } from '../blocks/registry';
import type { FlowGraph } from '../data/flowGraph';
import type { FlowValidationIssue } from '../engine/nodeDataValidation';

/** A `messageButton` field's value, once it is the two keys the control writes. */
export interface PickedButton {
    readonly messageKey: string;
    readonly buttonKey: string;
}

/** The two keys, or `undefined` for anything else — which is the schema's to complain about. */
function pickedButtonOf(value: unknown): PickedButton | undefined {
    if (!value || typeof value !== 'object') return undefined;
    const { messageKey, buttonKey } = value as Record<string, unknown>;
    if (typeof messageKey !== 'string' || typeof buttonKey !== 'string') return undefined;
    return { messageKey, buttonKey };
}

/** One visible `messageButton` field of one node, holding a pick. */
export interface ButtonPick {
    readonly nodeId: string;
    readonly fieldKey: string;
    readonly pick: PickedButton;
}

/**
 * Every visible `messageButton` field in the graph that holds a pick — found by control,
 * never by block, as `messageFieldsOf` finds `message` fields. A node whose block is not
 * registered has none; `validateNodeData` reports the unknown type.
 *
 * The one walk for "which buttons does this graph listen to": readiness below, the
 * one-flow-per-button check (`buttonClaims.ts`) and the listener list
 * (`journeyButtonListeners.ts`) all ask it. Needs the block registry.
 */
export function buttonPicksIn(graph: FlowGraph): readonly ButtonPick[] {
    const picks: ButtonPick[] = [];
    for (const node of graph.nodes) {
        const block = getBlockDefinition(node.type);
        if (!block) continue;
        for (const field of block.configFields) {
            if (field.control !== 'messageButton') continue;
            if (!isFieldVisible(field, block.configFields, node.data)) continue;
            const pick = pickedButtonOf(node.data[field.key]);
            if (pick) picks.push({ nodeId: node.id, fieldKey: field.key, pick });
        }
    }
    return picks;
}

/**
 * What is wrong with the buttons a graph's `messageButton` fields name, judged against what
 * the flow's journey declares — the message-button half of readiness, asked by
 * `flowReadinessIssues`, so the builder's marks, the list's count and the switch-on gate agree.
 *
 * Each issue is addressed to the field, and a field gets at most one:
 *
 *  - **The message must be one the journey declares**, as a message. A key that is gone, or
 *    names a channel or a role, gets "This flow's resources have no message …".
 *  - **The button must be one of that message's**, by key. A button removed from the message
 *    since gets "… has no button … any more".
 *  - **One button, one trigger per flow.** Two nodes naming the same button would start two
 *    runs from one press, so each of them gets the issue. Asked only of picks that passed the
 *    two rules above: a pick naming nothing is fixed by picking again, and blaming it for a
 *    clash too would be two complaints about one mistake.
 *
 * An empty or malformed value is skipped: the schema says "Fill this in." or what is wrong
 * with its shape. A field its `visibleWhen` hides is skipped, as every readiness check skips it.
 *
 * Needs the block registry, so a caller must have awaited discovery.
 */
export function messageButtonIssues(
    graph: FlowGraph,
    declarations: readonly ResourceDeclaration[]
): readonly FlowValidationIssue[] {
    const messages = new Map(
        declarations
            .filter((declaration) => declaration.kind === 'message')
            .map((declaration) => [declaration.key, declaration] as const)
    );

    const issues: FlowValidationIssue[] = [];
    const resolved: { readonly pick: ButtonPick; readonly label: string }[] = [];

    for (const entry of buttonPicksIn(graph)) {
        const { messageKey, buttonKey } = entry.pick;
        const message = messages.get(messageKey);
        if (!message) {
            issues.push({
                nodeId: entry.nodeId,
                field: entry.fieldKey,
                message: `This flow's resources have no message "${messageKey}". Pick another.`,
            });
            continue;
        }

        const button = message.buttons?.find((candidate) => candidate.key === buttonKey);
        if (!button) {
            issues.push({
                nodeId: entry.nodeId,
                field: entry.fieldKey,
                message: `"${message.defaultName}" has no button "${buttonKey}" any more. Pick another.`,
            });
            continue;
        }

        resolved.push({ pick: entry, label: buttonDisplayName(button) });
    }

    const pickCounts = new Map<string, number>();
    const identityOf = ({ pick }: ButtonPick): string => JSON.stringify([pick.messageKey, pick.buttonKey]);
    for (const { pick } of resolved) {
        pickCounts.set(identityOf(pick), (pickCounts.get(identityOf(pick)) ?? 0) + 1);
    }
    for (const { pick, label } of resolved) {
        if ((pickCounts.get(identityOf(pick)) ?? 0) < 2) continue;
        issues.push({
            nodeId: pick.nodeId,
            field: pick.fieldKey,
            message: `Two triggers in this flow listen to "${label}". One press starts one run.`,
        });
    }

    return issues;
}
