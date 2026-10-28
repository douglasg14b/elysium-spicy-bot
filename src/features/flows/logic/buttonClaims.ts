import type { ResourceDeclaration } from '../../provisioning';
// From its module, not the barrel: the barrel loads the provisioning service and its database.
import { buttonDisplayName } from '../../provisioning/logic/messageButtons';
import type { FlowGraph } from '../data/flowGraph';
import { blockButtonPicksIn, postedButtonNodeOf, postedNodeName, type PickedBlockButton } from './blockButtonReferences';
import { buttonPicksIn, type PickedButton } from './messageButtonReferences';
import type { ReadinessFlow } from './readinessScope';

/**
 * One flow per button (step 3, `docs/plans/message-resource-step-3.md`, pick 3; and a block's
 * button, step 2 of `docs/plans/block-message-buttons-step-2.md`).
 *
 * A press on a message's button starts the one **live** flow of the message's journey whose
 * Button Click names that button. Two live flows naming it would leave the press nobody to
 * start — the router answers that race with "neither runs" — so the ways a second flow could
 * go live on a taken button are refused before they land: switching it on or saving its graph
 * while on (`decidePut`), and moving a live flow into the journey (the group and attach
 * routes). Pure; each caller reads the flows beforehand.
 *
 * A journey's button is named by keys, which mean "in my journey"; a block's by the posting
 * flow, node and key, compared exactly. Either way only flows of the same journey can collide:
 * a flow on no journey is the only one that may listen to its own posts.
 */

/** A flow as the claim check reads it. */
export interface ClaimingFlow {
    readonly flowId: string;
    readonly name: string;
    readonly enabled: boolean;
    readonly graph: FlowGraph;
}

/** A button another live flow of the journey already listens to, named for a refusal. */
export interface ButtonClaimConflict {
    /** The flow already listening. */
    readonly flowId: string;
    readonly flowName: string;
    /** The button both name, as the trigger stores it. */
    readonly button: PickedButton | PickedBlockButton;
    /**
     * The message's name, or its key when the journey no longer declares it — for a block's
     * button, `"<headline or block> in <posting flow>"`, or "a block's post" when the poster
     * cannot be read from here.
     */
    readonly messageName: string;
    /** What the button is called (`buttonDisplayName`), or its key when the message no longer has it. */
    readonly buttonLabel: string;
}

export interface ButtonClaimInput {
    /** The flow about to listen; never counted against itself. */
    readonly flowId: string;
    /** The graph it would run: the one arriving with the request, else the stored one. */
    readonly graph: FlowGraph;
    /** Candidate holders — any of the guild's flows; only those passing the two filters count. */
    readonly flows: readonly ClaimingFlow[];
    /**
     * The flows of the journey the button belongs to (`flowIdsInJourney`). A key means "in my
     * journey", so the same keys in another journey are another message's button.
     */
    readonly journeyFlowIds: ReadonlySet<string>;
    /** That journey's declarations, for the names in the refusal. */
    readonly declarations: readonly ResourceDeclaration[];
    /**
     * Flows that may have posted a block's button, for the post's name in the refusal — the
     * journey's flows, switched off ones included, since the poster need not be live. `flows`
     * cannot stand in: a caller may hand it only the live ones.
     */
    readonly posters: readonly ReadinessFlow[];
}

/**
 * The first button `graph` names that another **live** flow of the same journey already names,
 * or `undefined` when none is taken — a journey's button first, then a block's.
 *
 * Judged on the raw picks, not on whether they still name anything: a pick naming nothing is
 * a readiness issue of its own, and two flows on one pair of keys collide the moment the
 * message is declared again. Needs the block registry.
 */
export function buttonClaimConflict(input: ButtonClaimInput): ButtonClaimConflict | undefined {
    const holders = input.flows.filter(
        (flow) => flow.flowId !== input.flowId && flow.enabled && input.journeyFlowIds.has(flow.flowId)
    );
    if (holders.length === 0) return undefined;

    return journeyButtonConflict(input, holders) ?? blockButtonConflict(input, holders);
}

function journeyButtonConflict(
    input: ButtonClaimInput,
    holders: readonly ClaimingFlow[]
): ButtonClaimConflict | undefined {
    const heldBy = holders.map((flow) => ({ flow, picks: buttonPicksIn(flow.graph) }));

    for (const { pick } of buttonPicksIn(input.graph)) {
        const holder = heldBy.find(({ picks }) =>
            picks.some(
                (held) => held.pick.messageKey === pick.messageKey && held.pick.buttonKey === pick.buttonKey
            )
        );
        if (!holder) continue;

        const message = input.declarations.find(
            (declaration) => declaration.kind === 'message' && declaration.key === pick.messageKey
        );
        const button = message?.buttons?.find((candidate) => candidate.key === pick.buttonKey);
        return {
            flowId: holder.flow.flowId,
            flowName: holder.flow.name,
            button: pick,
            messageName: message?.defaultName ?? pick.messageKey,
            buttonLabel: button ? buttonDisplayName(button) : pick.buttonKey,
        };
    }

    return undefined;
}

function blockButtonConflict(input: ButtonClaimInput, holders: readonly ClaimingFlow[]): ButtonClaimConflict | undefined {
    const heldBy = holders.map((flow) => ({ flow, picks: blockButtonPicksIn(flow.graph) }));

    for (const { pick } of blockButtonPicksIn(input.graph)) {
        const holder = heldBy.find(({ picks }) =>
            picks.some(
                (held) =>
                    held.pick.flowId === pick.flowId &&
                    held.pick.nodeId === pick.nodeId &&
                    held.pick.buttonKey === pick.buttonKey
            )
        );
        if (!holder) continue;

        // The poster: the listener itself, or one of the flows that may post.
        const poster =
            pick.flowId === input.flowId
                ? { name: 'this flow', graph: input.graph }
                : input.posters.find((flow) => flow.flowId === pick.flowId);
        const node = poster?.graph.nodes.find((candidate) => candidate.id === pick.nodeId);
        const posted = node ? postedButtonNodeOf(node) : undefined;
        const button = posted?.buttons.find((candidate) => candidate.key === pick.buttonKey);
        return {
            flowId: holder.flow.flowId,
            flowName: holder.flow.name,
            button: pick,
            messageName: poster && posted ? `${postedNodeName(posted)} in ${poster.name}` : "a block's post",
            buttonLabel: button ? buttonDisplayName(button) : pick.buttonKey,
        };
    }

    return undefined;
}

/** Who already holds the button, the opening every refusal of a claim shares. */
function describeClaim(conflict: ButtonClaimConflict): string {
    return `"${conflict.flowName}" already listens to "${conflict.buttonLabel}" on "${conflict.messageName}".`;
}

/** The go-live refusal: this flow's trigger is the one to move. */
export function buttonClaimRefusal(conflict: ButtonClaimConflict): string {
    return `${describeClaim(conflict)} One flow per button — point this trigger at another.`;
}

/**
 * The refusal of moving a live flow into the journey — attaching or grouping — and the
 * group preview's warning before it. Either flow can give way, so it names both.
 */
export function buttonClaimMoveRefusal(conflict: ButtonClaimConflict, movingFlowName: string): string {
    return (
        `${describeClaim(conflict)} "${movingFlowName}" listens to it too, and one press starts one flow. ` +
        'Switch one of them off or point it at another button, then try again.'
    );
}
