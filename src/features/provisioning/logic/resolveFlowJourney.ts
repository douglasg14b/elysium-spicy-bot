import { flowJourneyLinksRepo, type FlowJourneyLinksRepo } from '../data/flowJourneyLinksRepo';
import { journeysRepo, type JourneysRepo } from '../data/journeysRepo';
import type { JourneyEntity } from '../data/journeysSchema';

/**
 * The journey a flow installs, and whether the attachment is recorded or inferred.
 *
 * `attached` distinguishes the two ways this resolved, and it exists because one
 * caller genuinely needs it: `flowJourney()` in `flowRoutes.ts` checks ownership
 * **positively** before creating channels and roles, and a recorded link row is the
 * positive evidence its comment asks for. Collapsing the two cases would hand that
 * check a journey it cannot tell apart from one an operator merely keyed to look like
 * a flow id.
 */
export interface ResolvedFlowJourney {
    readonly journey: JourneyEntity;
    /** True when a `flow_journey_links` row says so; false when only the fallback matched. */
    readonly attached: boolean;
}

export interface FlowJourneyResolverDeps {
    readonly links?: Pick<FlowJourneyLinksRepo, 'getJourneyKeyForFlow'>;
    readonly journeys?: Pick<JourneysRepo, 'getByKey'>;
}

/**
 * Resolve which journey a flow installs.
 *
 * The one place that answers the question, so the five call sites that used to ask it
 * by convention cannot drift apart on the answer. The link row is authoritative: a
 * flow attached to a journey whose key is not its own id resolves only through it,
 * which is the whole point of the table.
 *
 * ---
 *
 * **TEMPORARY — the `journeyKey === flowId` fallback below is deleted in slice E.**
 *
 * It exists for exactly one window: a journey created between this migration running
 * and this code deploying has no link row, because the backfill already ran and the
 * save path that writes links had not shipped yet. Without it those flows would
 * silently report that they declare nothing.
 *
 * It is **not** a second permanent resolution rule. Two concurrent rules is precisely
 * the "indistinguishable from the real design" bridge `root-cause-over-workarounds.md`
 * forbids, which is why the backfill is in the migration rather than lazy: by the time
 * E lands, every row that matters already has a link and this branch resolves nothing.
 *
 * It **logs whenever it fires**, which is what makes that claim checkable rather than
 * assumed: slice E's precondition is "the live guild confirms every row resolved", and
 * a silent bridge cannot tell "carried one straggler" apart from "is now the primary
 * rule". A comment tracking its own removal is exactly the thing this repo has watched
 * rot before.
 */
export async function resolveFlowJourney(
    guildId: string,
    flowId: string,
    deps: FlowJourneyResolverDeps = {}
): Promise<ResolvedFlowJourney | null> {
    const links = deps.links ?? flowJourneyLinksRepo;
    const journeys = deps.journeys ?? journeysRepo;

    const linkedKey = await links.getJourneyKeyForFlow(guildId, flowId);

    if (linkedKey) {
        const journey = await journeys.getByKey(guildId, linkedKey);
        // A link naming a journey that no longer exists resolves to nothing rather
        // than falling through: the flow's answer to "what do I install?" is that
        // journey, and quietly substituting a different one keyed like the flow would
        // install resources the operator never attached.
        return journey ? { journey, attached: true } : null;
    }

    // TEMPORARY (slice E deletes this): the pre-link convention, where a flow's
    // journey was the one keyed with its own id.
    const implicit = await journeys.getByKey(guildId, flowId);
    if (!implicit) {
        // Attached to nothing and declaring nothing — the normal state of most flows,
        // not the bridge firing. Deliberately not logged.
        return null;
    }

    console.warn(
        `[provisioning] Flow ${flowId} in guild ${guildId} resolved journey "${implicit.journeyKey}" ` +
            'through the pre-link fallback, not a link row. Slice E removes this path.'
    );

    return { journey: implicit, attached: false };
}
