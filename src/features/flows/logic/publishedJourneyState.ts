import type { Guild } from 'discord.js';
import {
    flowJourneyLinksRepo,
    plannedDeletions,
    plannedRefusals,
    previewUnpublish,
    type FlowJourneyLinksRepo,
} from '../../provisioning';
import { flowButtonMessagesRepo, type FlowButtonMessagesRepo } from '../data/flowButtonMessagesRepo';
import {
    toPublishedResource,
    type PublishedButtonMessage,
    type PublishedResource,
} from './publishedFlowState';

/**
 * What a **journey** currently has live in a guild.
 *
 * The journey-scoped twin of `getPublishedFlowState`, and the shape the flows page's
 * group header asks for. The difference is not cosmetic: a flow's answer covers one
 * flow's buttons, while a journey's covers the buttons of **every flow attached to it**,
 * because unpublishing the journey takes all of them down. Answering a group header with
 * one member's state — which the page did before this existed, by opening the flow dialog
 * through `flows[0]` — showed an inventory that was missing the siblings' messages while
 * the action beside it would have removed them.
 *
 * ## Why this lives flows-side
 *
 * Same reason as `publishedFlowState`, and it matters more here. This reads provisioning,
 * which is the permitted direction — flows may depend on provisioning, never the reverse.
 * Provisioning must not know flows exist, and nothing here asks it to: the fan-out from
 * a journey key to flow ids goes through `flow_journey_links`, whose rows are an
 * association provisioning already owns, and the *button messages* for each of those ids
 * are read on this side. Putting this function in provisioning would have meant
 * provisioning importing `flowButtonMessagesRepo`, which is exactly the edge the
 * resource write-back is a registered callback to avoid.
 */
export interface PublishedJourneyState {
    /**
     * Messages carrying trigger buttons for **any** flow on this journey.
     *
     * Flat rather than grouped by flow, and carrying no flow id. The dialog lists what is
     * posted and offers to take it down, and neither of those is a per-flow question —
     * the operator is acting on the journey. Attributing each row to its flow was tried
     * and removed: nothing consumed it, and the field would have made the journey route's
     * body a superset of the flow route's, which is exactly what stops the browser
     * holding one type for both.
     */
    readonly buttonMessages: readonly PublishedButtonMessage[];
    /** What unpublishing would delete from the guild. */
    readonly deletableResources: readonly PublishedResource[];
    /** What unpublishing would refuse to touch, and why. */
    readonly refusedResources: readonly PublishedResource[];
    /**
     * Whether buttons posted before this was recorded may still be out there.
     *
     * Always true, for the reason `PublishedFlowState` records at length: the table was
     * never backfilled and cannot be, because the message ids of earlier deploys were
     * never written down.
     */
    readonly mayHaveUnrecordedButtons: true;
}

interface PublishedJourneyStateDeps {
    readonly buttonMessagesRepo?: Pick<FlowButtonMessagesRepo, 'listByFlowId'>;
    readonly linksRepo?: Pick<FlowJourneyLinksRepo, 'listFlowIdsForJourney'>;
}

/**
 * Gather what a journey has live in the guild. Reads only.
 *
 * The resource half is an unpublish plan rather than a binding list, for the same reason
 * the flow version gives: the dialog must show what the teardown would *really* do,
 * refusals included, or it is a preview that lies about the operation it previews.
 *
 * The journey key is taken as given rather than resolved from a flow, which is the whole
 * point of this route existing — an operator acting on the group is acting on the journey
 * itself, and there is no "asking flow" whose attachment has to be consulted.
 *
 * **Callers must have already established that the journey exists in this guild.** This
 * plans against whatever key it is handed; a key from another guild would resolve no
 * bindings and report an empty state, which reads as "nothing installed" rather than as
 * the "not found" it actually is. The routes do that check before calling.
 */
export async function getPublishedJourneyState(
    guild: Guild,
    journeyKey: string,
    deps: PublishedJourneyStateDeps = {}
): Promise<PublishedJourneyState> {
    const buttonsRepo = deps.buttonMessagesRepo ?? flowButtonMessagesRepo;
    const links = deps.linksRepo ?? flowJourneyLinksRepo;

    // The plan and the attachment list are independent reads, so they overlap. The
    // per-flow button reads cannot start until the ids are known, which is the one
    // genuine sequencing point here.
    const [plan, attachedFlowIds] = await Promise.all([
        previewUnpublish(guild, journeyKey),
        links.listFlowIdsForJourney(guild.id, journeyKey),
    ]);

    const perFlow = await Promise.all(
        attachedFlowIds.map(async (flowId) => {
            const recorded = await buttonsRepo.listByFlowId(guild.id, flowId);
            return recorded.map((row) => ({
                channelId: row.channelId,
                messageId: row.messageId,
                nodeIds: row.nodeIds,
            }));
        })
    );

    return {
        buttonMessages: perFlow.flat(),
        deletableResources: plannedDeletions(plan).map(toPublishedResource),
        refusedResources: plannedRefusals(plan).map(toPublishedResource),
        mayHaveUnrecordedButtons: true,
    };
}
