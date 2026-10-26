/**
 * Who listens to a message resource's buttons, as the dashboard reads it.
 *
 * One flow per button (step 3): a Button Click trigger names `{ messageKey, buttonKey }` in its
 * own journey, and the server lists every trigger that does (`getJourneyButtonListeners`). The
 * builder's picker greys a button another flow holds, the message window names the flow under
 * each button and locks its key, and removing a listened button, message or channel asks
 * first. Every one of those answers comes from here, so they cannot disagree.
 *
 * Pure, as `resourceAdoption.ts` beside it is: the decisions are what is worth pinning, and the
 * components around them are layout.
 */

import type { BlockConfigField, ButtonListener, MessageButtonRef, ResourceDeclaration } from '@brattybot/web-sdk';
import { joinWithAnd } from './nameLists';

/** The two keys, when a stored value holds them; anything else reads as no pick. */
export function readButtonPick(value: unknown): MessageButtonRef | undefined {
    if (!value || typeof value !== 'object') return undefined;
    const { messageKey, buttonKey } = value as Record<string, unknown>;
    return typeof messageKey === 'string' && typeof buttonKey === 'string' ? { messageKey, buttonKey } : undefined;
}

/** A node on the canvas, as much of it as a pick is read from. */
export interface CanvasNode {
    readonly id: string;
    /** The block's declared fields; absent for a block this build does not have. */
    readonly fields: readonly BlockConfigField[] | undefined;
    readonly config: Record<string, unknown>;
}

/** This flow as the builder holds it, for laying its own triggers over the server's answer. */
export interface CanvasFlow {
    readonly flowId: string;
    /** The name in the toolbar, saved or not: it is what the operator calls this flow now. */
    readonly flowName: string;
    readonly enabled: boolean;
    readonly nodes: readonly CanvasNode[];
}

/**
 * The server's listeners with this flow's own replaced by what is on the canvas.
 *
 * The answer describes the **saved** graph, and a pick made a second ago is not in it — so the
 * builder drops its own flow's entries and adds the triggers on screen, and a pick shows as
 * this flow's at once, while one taken back stops showing.
 *
 * Found by control rather than by block type, as the server finds them (`buttonPicksIn`): any
 * field drawn by `messageButton` holds a pick.
 */
export function overlayCanvasListeners(answer: readonly ButtonListener[], canvas: CanvasFlow): ButtonListener[] {
    const others = answer.filter((listener) => listener.flowId !== canvas.flowId);
    const own = canvas.nodes.flatMap((node) =>
        (node.fields ?? [])
            .filter((field) => field.control === 'messageButton')
            .flatMap((field) => {
                const pick = readButtonPick(node.config[field.key]);
                return pick
                    ? [{ ...pick, flowId: canvas.flowId, flowName: canvas.flowName, nodeId: node.id, enabled: canvas.enabled }]
                    : [];
            })
    );
    return [...others, ...own];
}

/** The listeners as a picker reads them: the journey's, and which flow and node it is drawn for. */
export interface ButtonListenersView {
    readonly all: readonly ButtonListener[];
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

export function buttonHolder(view: ButtonListenersView, pick: MessageButtonRef): ButtonHolder {
    const naming = view.all.filter(
        (listener) => listener.messageKey === pick.messageKey && listener.buttonKey === pick.buttonKey
    );
    const others = naming.filter((listener) => listener.flowId !== view.flowId);
    if (others.length > 0) return { kind: 'otherFlows', flowNames: flowNamesOf(others) };
    if (naming.some((listener) => listener.nodeId === view.nodeId)) return { kind: 'thisNode' };
    return naming.length > 0 ? { kind: 'thisFlow' } : { kind: 'nobody' };
}

/** The listeners on one message's buttons. */
export function listenersOn(listeners: readonly ButtonListener[], messageKey: string): ButtonListener[] {
    return listeners.filter((listener) => listener.messageKey === messageKey);
}

/** The flows among `listeners`, by name, each once, in the order they come. */
export function flowNamesOf(listeners: readonly ButtonListener[]): string[] {
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
export function cutOffQuestion(listeners: readonly ButtonListener[], removing: CutOffThing): string {
    const names = flowNamesOf(listeners);
    const verb = names.length === 1 ? 'listens' : 'listen';
    const triggers = listeners.length === 1 ? 'That trigger' : 'Those triggers';
    return `${joinWithAnd(names)} ${verb} to ${WHAT_IS_LISTENED[removing]}. Remove it anyway? ${triggers} will need another button.`;
}
