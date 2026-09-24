import { flowJourneyLinksRepo } from '../../features/provisioning/data/flowJourneyLinksRepo';
import { journeysRepo } from '../../features/provisioning/data/journeysRepo';
import { resourceBindingsRepo } from '../../features/provisioning/data/resourceBindingsRepo';
import {
    groupBindingsByJourney,
    summariseJourneyInstall,
    type JourneyInstallState,
} from '../../features/provisioning/logic/journeyInstallState';

/**
 * Which journey each flow in a guild belongs to, resolved once for a whole list.
 *
 * The flows page groups rows by journey, so it needs this for every flow at once. Asking
 * `resolveFlowJourney` per flow would be an N+1 against two tables; this is the same
 * question asked in three queries, mirroring the join `GET /journeys` already performs.
 *
 * **It reproduces `resolveFlowJourney`'s fallback on purpose.** A link row is
 * authoritative, but a flow that predates the link table has no row — its journey is
 * found by the old convention, a journey keyed equal to the flow's own id. A join over
 * `flow_journey_links` alone would report those flows as belonging to nothing, and the
 * page would then disagree with the builder about the same flow. That fallback is
 * temporary and scheduled for deletion; when it goes, the second lookup here goes with
 * it and the tests below should start failing, which is the intent.
 *
 * Kept in `src/web/api/` rather than under `features/provisioning/` because it reads
 * `flows` as well as journeys, and provisioning must never import flows — the direction
 * `dependencyDirection.test.ts` enforces.
 */

/** What a flow's row needs to know about the journey it sits in. */
export interface FlowJourneyMembership {
    readonly journeyKey: string;
    readonly name: string;
    /** How many resources the journey declares, for the group header. */
    readonly resourceCount: number;
    /**
     * How many flows share this journey.
     *
     * The grouping rule in one number: **1 means render a plain row**. A journey holding
     * a single flow is the implicit case every flow has, and surfacing it would put the
     * concept in front of operators who have no use for it (PRD §5.8).
     */
    readonly memberCount: number;
    /**
     * Whether what this journey declares is actually in the guild.
     *
     * Carried on the list row rather than fetched per row by the page. The alternative was
     * `GET /journeys/:key/published` once per group — which plans a real teardown against
     * live Discord state, so it is both the most expensive call in this area and one
     * request per row on every page load.
     *
     * It is deliberately the **weaker** claim of the two: this reads the binding table, so
     * it says "install has run over this", not "every channel is still there". The chip it
     * drives asks the first question; the inventory dialog answers the second properly.
     * See `journeyInstallState.ts`.
     */
    readonly installState: JourneyInstallState;
    /** Declared resources with a live binding — the numerator behind `installState`. */
    readonly installedCount: number;
    /**
     * *Which* declared keys are live, for the declarations editor.
     *
     * Beside the count rather than instead of it because they answer different questions —
     * see `JourneyInstallSummary.installedKeys`. The editor needs the names to know which
     * keys are frozen: once a binding points at a key it is identity, and letting it follow
     * a rename orphans the binding and every node sidecar naming it.
     */
    readonly installedKeys: readonly string[];
}

/**
 * Build a `flowId → journey` map for every flow in a guild that has one.
 *
 * `flowIds` is the guild's full flow list, needed because the fallback is keyed on a
 * flow's own id — without it, a journey named after a flow could not be told apart from
 * one an operator happened to name the same thing.
 */
export async function loadFlowJourneyIndex(
    guildId: string,
    flowIds: readonly string[]
): Promise<ReadonlyMap<string, FlowJourneyMembership>> {
    // Three queries for the whole page, not three per row. The bindings join the other two
    // for the same reason they do: every row needs an install state, so asking per journey
    // would be an N+1 paid on every visit to the flows list.
    const [links, journeys, bindings] = await Promise.all([
        flowJourneyLinksRepo.listLinksForGuild(guildId),
        journeysRepo.listByGuildId(guildId),
        resourceBindingsRepo.listByGuild(guildId),
    ]);

    const bindingsByJourney = groupBindingsByJourney(bindings);

    const journeyByKey = new Map(journeys.map((journey) => [journey.journeyKey, journey] as const));

    // Resolve every flow to a key first, so member counts are computed over the same
    // set the map reports. Counting links alone would undercount any journey holding a
    // fallback-resolved flow, and a group of two could render as a plain row.
    const keyByFlowId = new Map<string, string>();

    for (const link of links) {
        if (journeyByKey.has(link.journeyKey)) {
            keyByFlowId.set(link.flowId, link.journeyKey);
        }
        // A link naming a journey that no longer exists resolves to nothing, matching
        // `resolveFlowJourney`, which deliberately does not fall through in that case.
    }

    for (const flowId of flowIds) {
        if (keyByFlowId.has(flowId)) continue;
        // The pre-link convention: the journey was keyed on the flow's own id.
        if (journeyByKey.has(flowId)) {
            keyByFlowId.set(flowId, flowId);
        }
    }

    const memberCounts = new Map<string, number>();
    for (const journeyKey of keyByFlowId.values()) {
        memberCounts.set(journeyKey, (memberCounts.get(journeyKey) ?? 0) + 1);
    }

    const index = new Map<string, FlowJourneyMembership>();
    for (const [flowId, journeyKey] of keyByFlowId) {
        const journey = journeyByKey.get(journeyKey);
        if (!journey) continue;

        const install = summariseJourneyInstall({
            declaredKeys: journey.resources.map((resource) => resource.key),
            bindings: bindingsByJourney.get(journeyKey) ?? [],
        });

        index.set(flowId, {
            journeyKey,
            name: journey.name,
            resourceCount: journey.resources.length,
            memberCount: memberCounts.get(journeyKey) ?? 1,
            installState: install.state,
            installedCount: install.installedCount,
            installedKeys: install.installedKeys,
        });
    }

    return index;
}
