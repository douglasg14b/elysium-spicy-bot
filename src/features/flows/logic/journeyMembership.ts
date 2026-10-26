import { flowJourneyLinksRepo, journeysRepo } from '../../provisioning';
import { flowsRepo } from '../data/flowsRepo';
import type { FlowEntity } from '../data/flowsSchema';

/** One `flow_journey_links` row, as the guild-wide read returns it. */
export interface FlowJourneyLink {
    readonly flowId: string;
    readonly journeyKey: string;
}

/**
 * Which of a guild's flows are in journey `journeyKey`: **a flow is in J only when
 * `resolveFlowJourney` would say J.** The one membership rule, so the install write-back,
 * the one-flow-per-button check, the listener list and the press router cannot disagree about
 * who is in a journey.
 *
 * That means, as `resolveFlowJourney` reads it:
 *
 *  - **A link row decides.** A flow linked to J is in it; a flow linked anywhere else is
 *    not, even when its own id is J. This is the case the old rule got wrong: it admitted a
 *    flow by its id alone, so a flow grouped away from the journey keyed on its id still
 *    counted as that journey's — and that journey's ids were written into it, and its
 *    buttons would answer for it.
 *  - **Only a flow with no link row at all** falls back to the pre-link convention: it is in
 *    the journey keyed on its own id. That fallback goes when `resolveFlowJourney`'s does.
 *  - Only the guild's real flows count, so a key that merely looks like a flow id pulls in
 *    nothing.
 *
 * Pure. It does **not** ask whether J exists: `resolveFlowJourney` answers nothing for a
 * journey that is gone, so a caller must have confirmed J is a row of this guild —
 * {@link flowsInJourney} does.
 */
export function flowIdsInJourney(input: {
    readonly journeyKey: string;
    /** Every link row in the guild — needed whole, to know who is linked elsewhere. */
    readonly links: readonly FlowJourneyLink[];
    readonly guildFlowIds: readonly string[];
}): ReadonlySet<string> {
    const linkedJourneyOf = new Map(input.links.map((link) => [link.flowId, link.journeyKey]));

    return new Set(
        input.guildFlowIds.filter((flowId) => {
            const linkedKey = linkedJourneyOf.get(flowId);
            return linkedKey === undefined ? flowId === input.journeyKey : linkedKey === input.journeyKey;
        })
    );
}

/**
 * The flows in journey `journeyKey` of this guild, by {@link flowIdsInJourney}'s rule — none
 * when the guild has no such journey, as `resolveFlowJourney` would resolve none to it.
 *
 * Three reads: the guild's flows, its links, and the journey row. The flow rows come back
 * whole, since every caller goes on to read their graphs.
 */
export async function flowsInJourney(guildId: string, journeyKey: string): Promise<FlowEntity[]> {
    const [flows, links, journey] = await Promise.all([
        flowsRepo.getByGuildId(guildId),
        flowJourneyLinksRepo.listLinksForGuild(guildId),
        journeysRepo.getByKey(guildId, journeyKey),
    ]);
    if (!journey) return [];

    const members = flowIdsInJourney({ journeyKey, links, guildFlowIds: flows.map((flow) => flow.flowId) });
    return flows.filter((flow) => members.has(flow.flowId));
}
