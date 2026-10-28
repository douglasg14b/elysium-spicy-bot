import { resolveFlowJourney } from '../../provisioning';
import type { MessageButton } from '../../provisioning/logic/messageButtons';
import { isTriggerStartedBy } from '../blocks/registry';
import type { FlowNode } from '../data/flowGraph';
import { flowsRepo } from '../data/flowsRepo';
import type { FlowEntity } from '../data/flowsSchema';
import { blockButtonPicksIn, postedButtonNodesIn } from './blockButtonReferences';
import type { FlowPostedMessageEntity } from './flowPostedMessagesSchema';
import { flowsInJourney } from './journeyMembership';

/**
 * Who listens to a button under a block's post (step 2,
 * `docs/plans/block-message-buttons-step-2.md`): for a press, the triggers it would start;
 * for the builder, every posting node of a journey and every trigger naming one.
 *
 * **Who may listen**: a flow in the posting flow's journey, by the one membership rule — or,
 * when the posting flow is on no journey, the posting flow itself. Always the **poster's**
 * journey: a listener's own journey decides nothing, so the same ids named from another
 * journey are never heard.
 */

/** A trigger a press on a block's button would start, with the flow it is in. */
export interface BlockButtonTrigger {
    readonly flow: FlowEntity;
    readonly node: FlowNode;
}

/**
 * The Button Click triggers, live and off, that name `buttonKey` on the node that posted
 * `record`'s message — only those with `startedBy: 'buttonClick'`, as the journey path keeps.
 *
 * None when the posting flow is gone or belongs to another guild, which is "nothing hooked
 * up". The posting node's **current** buttons are not asked: what was posted is what can be
 * pressed, and a trigger naming a key the node no longer posts is a readiness issue on its own
 * flow already.
 *
 * Reads the posting flow, then its journey and that journey's flows (`resolveFlowJourney`,
 * `flowsInJourney`). **Throws** `MalformedJourneyError` when the journey row is stored
 * malformed, as both of those do. Needs the block registry.
 */
export async function blockButtonTriggers(
    guildId: string,
    record: Pick<FlowPostedMessageEntity, 'flowId' | 'nodeId'>,
    buttonKey: string
): Promise<BlockButtonTrigger[]> {
    const poster = await flowsRepo.getByFlowId(record.flowId);
    if (!poster || poster.guildId !== guildId) return [];

    const journey = await resolveFlowJourney(guildId, poster.flowId);
    const flows = journey ? await flowsInJourney(guildId, journey.journey.journeyKey) : [poster];

    return flows.flatMap((flow) =>
        blockButtonPicksIn(flow.graph).flatMap(({ nodeId, pick }) => {
            if (pick.flowId !== record.flowId || pick.nodeId !== record.nodeId || pick.buttonKey !== buttonKey) {
                return [];
            }
            const node = flow.graph.nodes.find((candidate) => candidate.id === nodeId);
            return node && isTriggerStartedBy(node.type, 'buttonClick') ? [{ flow, node }] : [];
        })
    );
}

/** A node of a journey's flow that posts buttons, as the trigger's picker offers it. */
export interface BlockButtonMessage {
    /** The posting flow. */
    readonly flowId: string;
    readonly flowName: string;
    /** The posting node. */
    readonly nodeId: string;
    /** What its block is called (`Post Embed`). */
    readonly blockLabel: string;
    /** Its message as one line, or `null` when it has none — the block's label stands in. */
    readonly headline: string | null;
    /** The buttons it posts now. */
    readonly buttons: readonly MessageButton[];
}

/**
 * One trigger naming a block's button. The poster's ids are `messageFlowId` / `messageNodeId`;
 * `flowId` / `nodeId` are always the listener's, as in a journey button's listener.
 */
export interface BlockButtonListener {
    readonly messageFlowId: string;
    readonly messageNodeId: string;
    readonly buttonKey: string;
    readonly flowId: string;
    readonly flowName: string;
    readonly nodeId: string;
    readonly enabled: boolean;
}

/**
 * Every posting node of the journey's flows, and every trigger of those flows naming a
 * block's button, live and off — what the builder's picker offers and greys, and what a
 * block's message window names under each button. Pure: the caller has read the flows
 * (`flowsInJourney`). A pick is listed as it stands, naming something gone included, as the
 * journey half lists them. Needs the block registry.
 */
export function journeyBlockButtons(flows: readonly FlowEntity[]): {
    readonly blockMessages: BlockButtonMessage[];
    readonly blockListeners: BlockButtonListener[];
} {
    return {
        blockMessages: flows.flatMap((flow) =>
            postedButtonNodesIn(flow.graph).map(({ nodeId, blockLabel, headline, buttons }) => ({
                flowId: flow.flowId,
                flowName: flow.name,
                nodeId,
                blockLabel,
                headline,
                buttons,
            }))
        ),
        blockListeners: flows.flatMap((flow) =>
            blockButtonPicksIn(flow.graph).map(({ nodeId, pick }) => ({
                messageFlowId: pick.flowId,
                messageNodeId: pick.nodeId,
                buttonKey: pick.buttonKey,
                flowId: flow.flowId,
                flowName: flow.name,
                nodeId,
                enabled: flow.enabled,
            }))
        ),
    };
}
