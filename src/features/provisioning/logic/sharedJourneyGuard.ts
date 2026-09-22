import { flowJourneyLinksRepo, type FlowJourneyLinksRepo } from '../data/flowJourneyLinksRepo';

/**
 * Who else is holding this journey.
 *
 * One question — *"would this operation hurt a flow other than the one asking?"* —
 * asked from the three places that can damage a shared journey: clearing a flow's
 * resource panel, unpublishing from a flow, and deleting the journey outright. Each
 * had its own answer before this existed, and two of the three were wrong in the same
 * way: they compared the journey's key to the flow's id, which is the convention the
 * link table replaced. That comparison is right only while a journey holds one flow,
 * so it silently stops being right the moment the feature this slice enables is used.
 *
 * Keeping it here rather than in the route also puts the refusal copy next to the rule
 * that produces it, matching `buildUnpublishPlan`'s cascade refusal — the precedent
 * these messages are shaped after — rather than diverging from it by living in
 * `src/web/api/`, where slices C and D could not reach it.
 */

/** Names an attached flow, for a refusal an operator has to act on. */
export interface AttachedFlow {
    readonly flowId: string;
    /** The flow's name, or its id when the row is gone — never omitted. */
    readonly label: string;
}

export interface SharedJourneyDeps {
    readonly links?: Pick<FlowJourneyLinksRepo, 'listFlowIdsForJourney'>;
    /** Resolves a flow id to its display name; missing rows yield undefined. */
    readonly flowName: (flowId: string) => Promise<string | undefined>;
}

/**
 * Every flow attached to a journey **other than** the one asking.
 *
 * `exceptFlowId` is the caller's own flow, which must not count against it: a flow is
 * always allowed to act on a journey it alone holds, and including it would refuse
 * every operation including the ones that are fine.
 *
 * A flow whose row has vanished keeps its id as the label rather than being dropped. A
 * dangling link is still something blocking the operation, and omitting it would
 * produce a refusal that names fewer flows than it is refusing for.
 */
export async function otherFlowsOnJourney(
    guildId: string,
    journeyKey: string,
    exceptFlowId: string | null,
    deps: SharedJourneyDeps
): Promise<AttachedFlow[]> {
    const links = deps.links ?? flowJourneyLinksRepo;
    const attachedFlowIds = await links.listFlowIdsForJourney(guildId, journeyKey);

    return Promise.all(
        attachedFlowIds
            .filter((flowId) => flowId !== exceptFlowId)
            .map(async (flowId) => ({ flowId, label: (await deps.flowName(flowId)) ?? flowId }))
    );
}

/**
 * The refusal shown when flows still hold a journey.
 *
 * **Names every flow** rather than counting them. A count tells an operator the size of
 * a problem they then have to go and find; the names are what they act on, and it is
 * the shape `buildUnpublishPlan`'s category-cascade refusal already uses.
 *
 * `action` completes "…would " — each caller says what *its* operation would do, since
 * "delete the journey", "clear these resources" and "destroy these channels" are three
 * different damages and a generic sentence would describe none of them.
 */
export function sharedJourneyRefusal(input: {
    readonly journeyName: string;
    readonly action: string;
    readonly others: readonly AttachedFlow[];
}): string {
    const names = input.others.map((flow) => `**${flow.label}**`);
    const subject =
        names.length === 1
            ? `the flow ${names[0]} still installs it`
            : `${names.length} flows still install it: ${names.join(', ')}`;

    return `${input.action} **${input.journeyName}** would ${names.length === 1 ? 'affect a flow' : 'affect flows'} that did not ask for it, and ${subject}. Detach ${names.length === 1 ? 'it' : 'them'} first.`;
}
