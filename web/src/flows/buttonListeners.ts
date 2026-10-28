/**
 * Who listens to a button, as the dashboard reads it — a message resource's button, or one
 * under a block's post.
 *
 * One flow per button (step 3): a Button Click trigger names `{ messageKey, buttonKey }` in its
 * own journey, or `{ flowId, nodeId, buttonKey }` under a block's post (step 2 of
 * `docs/plans/block-message-buttons-step-2.md`), and the server lists every trigger that does
 * and every block posting buttons (`getJourneyButtonListeners`). The builder's picker greys a
 * button another flow holds, the message window names the flow under each button and locks its
 * key, and removing a listened button, message or channel asks first. Every one of those
 * answers comes from here, so they cannot disagree.
 *
 * Pure, as `resourceAdoption.ts` beside it is: the decisions are what is worth pinning, and the
 * components around them are layout.
 */

import type {
    BlockButtonListener,
    BlockButtonMessage,
    BlockButtonRef,
    BlockConfigField,
    ButtonListener,
    JourneyButtonListeners,
    JourneyButtonRef,
    MessageButtonRef,
    ResourceDeclaration,
} from '@brattybot/web-sdk';
import { asMessageButtons } from './controls/types';
import { joinWithAnd } from './nameLists';
import { readStoredMessage } from './storedMessage';
import { isFieldVisible } from './variables';

/**
 * The pick a stored value holds: a message resource's button (two keys) when it holds a
 * `messageKey`, else a block's (the poster's ids and a key) — the arm order of the server's
 * union. Anything else reads as no pick.
 */
export function readButtonPick(value: unknown): MessageButtonRef | undefined {
    if (!value || typeof value !== 'object') return undefined;
    const { messageKey, buttonKey, flowId, nodeId } = value as Record<string, unknown>;
    if (typeof buttonKey !== 'string') return undefined;
    if (typeof messageKey === 'string') return { messageKey, buttonKey };
    return typeof flowId === 'string' && typeof nodeId === 'string' ? { flowId, nodeId, buttonKey } : undefined;
}

/** Whether a pick names a message resource's button rather than a block's. */
export function isJourneyButtonRef(pick: MessageButtonRef): pick is JourneyButtonRef {
    return 'messageKey' in pick;
}

/** A node on the canvas, as much of it as a pick or a posted message is read from. */
export interface CanvasNode {
    readonly id: string;
    /** What its block is called (`Post Embed`); absent for a block this build does not have. */
    readonly blockLabel: string | undefined;
    /** The block's declared fields; absent for a block this build does not have. */
    readonly fields: readonly BlockConfigField[] | undefined;
    readonly config: Record<string, unknown>;
}

/** This flow as the builder holds it, for laying its own triggers and posts over the server's answer. */
export interface CanvasFlow {
    readonly flowId: string;
    /** The name in the toolbar, saved or not: it is what the operator calls this flow now. */
    readonly flowName: string;
    readonly enabled: boolean;
    readonly nodes: readonly CanvasNode[];
}

/** The server's answer, or the builder's version of it with this flow's canvas laid over. */
export type ButtonAnswer = Pick<JourneyButtonListeners, 'listeners' | 'blockMessages' | 'blockListeners'>;

/** No journey to ask about, or no answer yet: nobody else listens, and no other flow posts. */
export const NO_BUTTON_ANSWER: ButtonAnswer = { listeners: [], blockMessages: [], blockListeners: [] };

/**
 * The server's answer with this flow's own entries replaced by what is on the canvas — its
 * triggers' picks, both kinds, and its blocks posting buttons.
 *
 * The answer describes the **saved** graph, and a pick made a second ago is not in it — so the
 * builder drops its own flow's entries and adds what is on screen, and a pick shows as this
 * flow's at once, while one taken back stops showing. With no journey the answer is empty and
 * this is the canvas alone, which is all a flow on no journey can listen to.
 *
 * Found by control rather than by block type, as the server finds them: any field drawn by
 * `messageButton` holds a pick, and any visible `message` field naming a `buttonsKey` posts
 * buttons. Each listener is built field by field: a block pick's own `flowId` and `nodeId` are
 * the **poster's**, and spreading one would put them where the listener's go.
 */
export function overlayCanvas(answer: ButtonAnswer, canvas: CanvasFlow): ButtonAnswer {
    const listeners: ButtonListener[] = answer.listeners.filter((listener) => listener.flowId !== canvas.flowId);
    const blockListeners: BlockButtonListener[] = answer.blockListeners.filter(
        (listener) => listener.flowId !== canvas.flowId
    );
    const blockMessages: BlockButtonMessage[] = [];

    for (const node of canvas.nodes) {
        const fields = node.fields ?? [];
        for (const field of fields) {
            if (field.control === 'messageButton') {
                const pick = readButtonPick(node.config[field.key]);
                if (!pick) continue;
                const listener = {
                    flowId: canvas.flowId,
                    flowName: canvas.flowName,
                    nodeId: node.id,
                    enabled: canvas.enabled,
                    buttonKey: pick.buttonKey,
                };
                if (isJourneyButtonRef(pick)) {
                    listeners.push({ ...listener, messageKey: pick.messageKey });
                } else {
                    blockListeners.push({ ...listener, messageFlowId: pick.flowId, messageNodeId: pick.nodeId });
                }
            }
        }
        const posted = postedMessageOf(node, canvas);
        if (posted) blockMessages.push(posted);
    }

    return {
        listeners,
        blockListeners,
        blockMessages: [...blockMessages, ...answer.blockMessages.filter((message) => message.flowId !== canvas.flowId)],
    };
}

/**
 * What a canvas node posts, when it posts buttons: its first visible `message` field naming a
 * `buttonsKey`, as the server reads a saved node (`postedButtonNodeOf`).
 */
function postedMessageOf(node: CanvasNode, canvas: CanvasFlow): BlockButtonMessage | undefined {
    const fields = node.fields ?? [];
    for (const field of fields) {
        if (field.control !== 'message' || !field.buttonsKey) continue;
        if (!isFieldVisible(field, fields, node.config)) continue;
        return {
            flowId: canvas.flowId,
            flowName: canvas.flowName,
            nodeId: node.id,
            blockLabel: node.blockLabel ?? 'A block',
            headline: postHeadline(node.config[field.key]),
            buttons: [...asMessageButtons(node.config[field.buttonsKey])],
        };
    }
    return undefined;
}

/**
 * A message as one line — its first embed's title, else that embed's body, else its text,
 * each trimmed and skipped when blank — or `null`. As the server's `messageHeadline` reads it
 * (`blockButtonReferences.ts`), so a post is named alike from the canvas and from the answer.
 */
function postHeadline(raw: unknown): string | null {
    const { content, embeds } = readStoredMessage(raw);
    return embeds[0]?.title?.trim() || embeds[0]?.description?.trim() || content?.trim() || null;
}

/** What a picker or a card calls a block's post: its headline, else its block's label. */
export function postName(message: Pick<BlockButtonMessage, 'headline' | 'blockLabel'>): string {
    return message.headline ?? message.blockLabel;
}

/** The posted message a block pick names, among those offered. */
export function blockMessageOf(
    messages: readonly BlockButtonMessage[],
    pick: Pick<BlockButtonRef, 'flowId' | 'nodeId'>
): BlockButtonMessage | undefined {
    return messages.find((message) => message.flowId === pick.flowId && message.nodeId === pick.nodeId);
}

/**
 * Who listens to what, as a picker reads it — the journey's buttons' listeners, the block posts
 * on offer and their listeners, with this flow's canvas laid over — and which flow and node it
 * is drawn for.
 */
export interface ButtonListenersView extends ButtonAnswer {
    readonly flowId: string;
    readonly nodeId: string;
}

/**
 * Who holds a button, from where the picker stands.
 *
 * `otherFlows` wins over this flow's own: a button another flow already listens to is the one
 * the one-flow-per-button rule refuses, so it is what the picker must say. Off flows count —
 * a flow switched off still names the button, and switching it back on would collide.
 */
export type ButtonHolder =
    | { readonly kind: 'nobody' }
    | { readonly kind: 'thisNode' }
    | { readonly kind: 'thisFlow' }
    | { readonly kind: 'otherFlows'; readonly flowNames: readonly string[] };

/** Who holds the button a pick names — a journey message's or a block post's. */
export function buttonHolder(view: ButtonListenersView, pick: MessageButtonRef): ButtonHolder {
    const naming: readonly Pick<ButtonListener, 'flowId' | 'flowName' | 'nodeId'>[] = isJourneyButtonRef(pick)
        ? view.listeners.filter(
              (listener) => listener.messageKey === pick.messageKey && listener.buttonKey === pick.buttonKey
          )
        : view.blockListeners.filter(
              (listener) =>
                  listener.messageFlowId === pick.flowId &&
                  listener.messageNodeId === pick.nodeId &&
                  listener.buttonKey === pick.buttonKey
          );
    const others = naming.filter((listener) => listener.flowId !== view.flowId);
    if (others.length > 0) return { kind: 'otherFlows', flowNames: flowNamesOf(others) };
    if (naming.some((listener) => listener.nodeId === view.nodeId)) return { kind: 'thisNode' };
    return naming.length > 0 ? { kind: 'thisFlow' } : { kind: 'nobody' };
}

/** A listener as a message window reads it under a button: which button, and whose flow. */
export type ListenerOnButton = Pick<ButtonListener, 'buttonKey' | 'flowName'>;

/** The listeners on one message's buttons. */
export function listenersOn(listeners: readonly ButtonListener[], messageKey: string): ButtonListener[] {
    return listeners.filter((listener) => listener.messageKey === messageKey);
}

/** The listeners on one block's posted buttons: that flow's node, by the poster's ids. */
export function listenersOnPost(
    listeners: readonly BlockButtonListener[],
    post: { readonly flowId: string; readonly nodeId: string }
): BlockButtonListener[] {
    return listeners.filter(
        (listener) => listener.messageFlowId === post.flowId && listener.messageNodeId === post.nodeId
    );
}

/** The flows among `listeners`, by name, each once, in the order they come. */
export function flowNamesOf(listeners: readonly Pick<ButtonListener, 'flowName'>[]): string[] {
    return [...new Set(listeners.map((listener) => listener.flowName))];
}

/** The keys of the messages somebody listens to, whose keys must stop following their names. */
export function listenedMessageKeys(listeners: readonly ButtonListener[]): ReadonlySet<string> {
    return new Set(listeners.map((listener) => listener.messageKey));
}

/**
 * Who a removal would cut off: the listeners on a message, or on every message posted in a
 * channel. Removing a channel leaves its messages with nowhere to go — the press still finds
 * nothing until somebody gives them one — so it asks as removing the message itself does.
 */
export function listenersCutOffBy(
    removed: ResourceDeclaration,
    resources: readonly ResourceDeclaration[],
    listeners: readonly ButtonListener[]
): ButtonListener[] {
    switch (removed.kind) {
        case 'message':
            return listenersOn(listeners, removed.key);
        case 'textChannel': {
            const inChannel = new Set(
                resources
                    .filter((resource) => resource.kind === 'message' && resource.parentKey === removed.key)
                    .map((resource) => resource.key)
            );
            return listeners.filter((listener) => inChannel.has(listener.messageKey));
        }
        case 'category':
        case 'role':
        case 'ticketType':
            return [];
        default: {
            const unreachable: never = removed.kind;
            throw new Error(`Unhandled resource kind: ${String(unreachable)}`);
        }
    }
}

/** What a removal takes from its listeners: the button itself, or the message one sits on. */
export type CutOffThing = 'button' | 'message' | 'channel';

const WHAT_IS_LISTENED: Readonly<Record<CutOffThing, string>> = {
    button: 'this button',
    message: 'a button on this message',
    channel: 'a button on a message in this channel',
};

/**
 * The question a removal asks before it cuts listeners off: "Welcome listens to this button.
 * Remove it anyway? That trigger will need another button."
 */
export function cutOffQuestion(listeners: readonly Pick<ButtonListener, 'flowName'>[], removing: CutOffThing): string {
    const names = flowNamesOf(listeners);
    const verb = names.length === 1 ? 'listens' : 'listen';
    const triggers = listeners.length === 1 ? 'That trigger' : 'Those triggers';
    return `${joinWithAnd(names)} ${verb} to ${WHAT_IS_LISTENED[removing]}. Remove it anyway? ${triggers} will need another button.`;
}
