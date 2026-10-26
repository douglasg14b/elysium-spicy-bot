import type { ButtonListener } from '../../provisioning';
import type { FlowNode } from '../data/flowGraph';
import type { FlowEntity } from '../data/flowsSchema';
import { flowsInJourney } from './journeyMembership';
import { buttonPicksIn } from './messageButtonReferences';

/** One listening trigger, with the flow and the node it is — what a press needs to start a run. */
export interface ButtonTrigger {
    readonly listener: ButtonListener;
    readonly flow: FlowEntity;
    readonly node: FlowNode;
}

/**
 * Every trigger of the journey's flows that names one of its messages' buttons, live and off,
 * with its flow and node.
 *
 * The flows are the journey's by the one membership rule (`flowsInJourney`), so a flow grouped
 * away no longer listens here, and none are listed for a journey the guild does not have. Each
 * pick is listed as it stands — a key the journey no longer declares included — so a caller
 * that matches a press against it, or shows who would be cut off, sees every trigger naming
 * the keys. Needs the block registry.
 *
 * **Throws** `MalformedJourneyError` when the journey row is stored malformed, as
 * `flowsInJourney` does.
 */
export async function journeyButtonTriggers(guildId: string, journeyKey: string): Promise<ButtonTrigger[]> {
    const flows = await flowsInJourney(guildId, journeyKey);

    return flows.flatMap((flow) =>
        buttonPicksIn(flow.graph).map(({ nodeId, pick }) => {
            const node = flow.graph.nodes.find((candidate) => candidate.id === nodeId);
            if (!node) {
                // `buttonPicksIn` walks these same nodes, so this is a broken invariant, not a case.
                throw new Error(`Flow ${flow.flowId} names a button from node ${nodeId}, which its graph does not hold.`);
            }
            const listener: ButtonListener = {
                messageKey: pick.messageKey,
                buttonKey: pick.buttonKey,
                flowId: flow.flowId,
                flowName: flow.name,
                nodeId,
                enabled: flow.enabled,
            };
            return { listener, flow, node };
        })
    );
}

/**
 * {@link journeyButtonTriggers}, as the listener list the route sends and provisioning reads
 * through its hook (`registerButtonListenerReader`, in `initFlows`).
 */
export async function journeyButtonListeners(guildId: string, journeyKey: string): Promise<ButtonListener[]> {
    return (await journeyButtonTriggers(guildId, journeyKey)).map((trigger) => trigger.listener);
}
