import {
    buttonDisplayName,
    MESSAGE_BUTTON_STYLES,
    type MessageButton,
    type MessageButtonEmoji,
} from '../../provisioning/logic/messageButtons';
import { isFieldVisible } from '../blocks/manifest';
import { getBlockDefinition } from '../blocks/registry';
import type { FlowGraph, FlowNode } from '../data/flowGraph';
import type { FlowValidationIssue } from '../engine/nodeDataValidation';
import { buttonFieldValuesIn, twoTriggersOnOneButtonMessage } from './messageButtonReferences';
import type { ReadinessScope } from './readinessScope';

/**
 * Button Click listening to a button under a block's post (step 2,
 * `docs/plans/block-message-buttons-step-2.md`): which picks a graph holds, which of its nodes
 * post buttons, and what readiness says about a pick that names nothing.
 *
 * Found by control everywhere, never by block type: a pick is any `messageButton` field holding
 * `{ flowId, nodeId, buttonKey }`, and a posting node is any node whose visible `message` field
 * declares a `buttonsKey`. Needs the block registry.
 */

/** A `messageButton` field's value, once it names a block's button: the poster and the button's key. */
export interface PickedBlockButton {
    /** The posting flow — written even when it is the listener's own. */
    readonly flowId: string;
    /** The posting node in that flow. */
    readonly nodeId: string;
    readonly buttonKey: string;
}

/** One visible `messageButton` field of one node, naming a block's button. */
export interface BlockButtonPick {
    readonly nodeId: string;
    readonly fieldKey: string;
    readonly pick: PickedBlockButton;
}

/**
 * The poster's ids and the key, or `undefined` for anything else. A value holding a
 * `messageKey` is a message resource's button whatever else it holds — the schema's union
 * tries that arm first, so this reads it the same way.
 */
function pickedBlockButtonOf(value: unknown): PickedBlockButton | undefined {
    if (!value || typeof value !== 'object') return undefined;
    const { messageKey, flowId, nodeId, buttonKey } = value as Record<string, unknown>;
    if (typeof messageKey === 'string') return undefined;
    if (typeof flowId !== 'string' || typeof nodeId !== 'string' || typeof buttonKey !== 'string') return undefined;
    return { flowId, nodeId, buttonKey };
}

/**
 * Every visible `messageButton` field in the graph that names a block's button. The block half
 * of what a graph listens to, beside `buttonPicksIn`'s journey half: readiness, the
 * one-flow-per-button check and the listener lists ask it.
 */
export function blockButtonPicksIn(graph: FlowGraph): readonly BlockButtonPick[] {
    return buttonFieldValuesIn(graph).flatMap(({ nodeId, fieldKey, value }) => {
        const pick = pickedBlockButtonOf(value);
        return pick ? [{ nodeId, fieldKey, pick }] : [];
    });
}

/** A node that posts a message with buttons under it, as a picker and readiness read it. */
export interface PostedButtonNode {
    readonly nodeId: string;
    /** What the block is called (`Post Embed`), for a sentence or a picker naming it. */
    readonly blockLabel: string;
    /**
     * The message as one line — its first embed's title, else that embed's body, else its plain
     * text — or `null` when it has none of them, so the block's label stands in.
     */
    readonly headline: string | null;
    /** The buttons it posts now, as far as each can be read. Empty when it posts none yet. */
    readonly buttons: readonly MessageButton[];
}

/**
 * The buttons a node posts, if it is a posting node: its first visible `message` field that
 * declares a `buttonsKey`. `undefined` for any other node — a block with no such field, or one
 * whose field is hidden. A block declares at most one message field with buttons in practice;
 * conformance refuses two on one key.
 */
export function postedButtonNodeOf(node: FlowNode): PostedButtonNode | undefined {
    const block = getBlockDefinition(node.type);
    if (!block) return undefined;
    for (const field of block.configFields) {
        if (field.control !== 'message' || !field.buttonsKey) continue;
        if (!isFieldVisible(field, block.configFields, node.data)) continue;
        return {
            nodeId: node.id,
            blockLabel: block.label,
            headline: messageHeadline(node.data[field.key]),
            buttons: readPostedButtons(node.data[field.buttonsKey]),
        };
    }
    return undefined;
}

/** Every node of the graph that posts buttons ({@link postedButtonNodeOf}), in graph order. */
export function postedButtonNodesIn(graph: FlowGraph): readonly PostedButtonNode[] {
    return graph.nodes.flatMap((node) => {
        const posted = postedButtonNodeOf(node);
        return posted ? [posted] : [];
    });
}

/**
 * The buttons stored under a `buttonsKey`, keeping only entries a picker can draw and a press
 * could match: a string key, one of the four styles, a string label or none, an emoji object or
 * none. A broken entry is the node's own readiness issue; here it simply offers nothing.
 */
function readPostedButtons(raw: unknown): readonly MessageButton[] {
    if (!Array.isArray(raw)) return [];
    const styles: readonly string[] = MESSAGE_BUTTON_STYLES;
    return raw.flatMap((entry: unknown): MessageButton[] => {
        if (!entry || typeof entry !== 'object') return [];
        const { key, label, style, emoji } = entry as Record<string, unknown>;
        if (typeof key !== 'string' || typeof style !== 'string' || !styles.includes(style)) return [];
        if (label !== undefined && typeof label !== 'string') return [];
        const readEmoji = emojiOf(emoji);
        if (emoji !== undefined && !readEmoji) return [];
        return [
            {
                key,
                style: style as MessageButton['style'],
                ...(label !== undefined ? { label } : {}),
                ...(readEmoji ? { emoji: readEmoji } : {}),
            },
        ];
    });
}

function emojiOf(raw: unknown): MessageButtonEmoji | undefined {
    if (!raw || typeof raw !== 'object') return undefined;
    const { name, id, animated } = raw as Record<string, unknown>;
    if (typeof name !== 'string') return undefined;
    return {
        name,
        ...(typeof id === 'string' ? { id } : {}),
        ...(typeof animated === 'boolean' ? { animated } : {}),
    };
}

/** A stored message as one line, or `null` — see {@link PostedButtonNode.headline}. */
function messageHeadline(raw: unknown): string | null {
    if (!raw || typeof raw !== 'object') return null;
    const { content, embeds } = raw as Record<string, unknown>;
    const first: unknown = Array.isArray(embeds) ? embeds[0] : undefined;
    if (first && typeof first === 'object') {
        const { title, description } = first as Record<string, unknown>;
        if (typeof title === 'string' && title.trim()) return title.trim();
        if (typeof description === 'string' && description.trim()) return description.trim();
    }
    return typeof content === 'string' && content.trim() ? content.trim() : null;
}

/** What a sentence calls a posting node: its message's headline, else its block's label. */
export function postedNodeName(posted: Pick<PostedButtonNode, 'headline' | 'blockLabel'>): string {
    return posted.headline ?? posted.blockLabel;
}

/**
 * What is wrong with the block buttons a graph's `messageButton` fields name, judged against
 * the flow itself and its journey's other flows — the block half of readiness, asked by
 * `flowReadinessIssues` beside `messageButtonIssues`, so the builder's marks, the list's count
 * and the switch-on gate agree.
 *
 * Each issue is addressed to the field, and a field gets at most one:
 *
 *  - **The posting flow must be one that may be listened to**: this flow, or another flow of
 *    its journey. A flow moved to another journey, or deleted, reads the same from here.
 *  - **The posting node must still be there**,
 *  - **must still post buttons** — a node whose block posts none, or whose message field is
 *    hidden,
 *  - **and must still have the button**, by key. What it posted earlier is what a press on an
 *    old message matches; what it has now is what a new one will carry.
 *  - **One button, one trigger per flow**, as for a journey's button: asked only of picks that
 *    passed the rules above.
 *
 * A pick naming this flow is judged against `graph` — the graph being judged, a draft or an
 * unsaved canvas included — never a stored copy. Pure: the scope is loaded beforehand.
 */
export function blockButtonIssues(graph: FlowGraph, scope: ReadinessScope): readonly FlowValidationIssue[] {
    const issues: FlowValidationIssue[] = [];
    const resolved: { readonly entry: BlockButtonPick; readonly label: string }[] = [];

    for (const entry of blockButtonPicksIn(graph)) {
        const { flowId, nodeId, buttonKey } = entry.pick;
        const issue = (message: string): void => {
            issues.push({ nodeId: entry.nodeId, field: entry.fieldKey, message });
        };

        const posterGraph =
            scope.flowId !== null && flowId === scope.flowId
                ? graph
                : scope.journeyFlows.find((candidate) => candidate.flowId === flowId)?.graph;
        if (!posterGraph) {
            issue("That button's flow isn't in this flow's journey any more, or it's gone. Pick another.");
            continue;
        }

        const node = posterGraph.nodes.find((candidate) => candidate.id === nodeId);
        if (!node) {
            issue('The block that posts that button is gone. Pick another.');
            continue;
        }

        const posted = postedButtonNodeOf(node);
        if (!posted) {
            issue("That block doesn't post buttons. Pick another.");
            continue;
        }

        const button = posted.buttons.find((candidate) => candidate.key === buttonKey);
        if (!button) {
            issue(`"${postedNodeName(posted)}" has no button "${buttonKey}" any more. Pick another.`);
            continue;
        }

        resolved.push({ entry, label: buttonDisplayName(button) });
    }

    const identityOf = ({ pick }: BlockButtonPick): string => JSON.stringify([pick.flowId, pick.nodeId, pick.buttonKey]);
    const counts = new Map<string, number>();
    for (const { entry } of resolved) {
        counts.set(identityOf(entry), (counts.get(identityOf(entry)) ?? 0) + 1);
    }
    for (const { entry, label } of resolved) {
        if ((counts.get(identityOf(entry)) ?? 0) < 2) continue;
        issues.push({ nodeId: entry.nodeId, field: entry.fieldKey, message: twoTriggersOnOneButtonMessage(label) });
    }

    return issues;
}
