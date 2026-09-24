import type { Guild } from 'discord.js';
import { flowJourneyLinksRepo, resolveJourneyResources } from '../../provisioning';
import { flowsRepo } from '../data/flowsRepo';
import { bindResourcesToGraph, type ResourceBindingTarget } from './bindResourcesToGraph';
import { collectResourceTargets } from './resourceTargets';

export interface ApplyResourcesResult {
    /** Flows whose graph was rewritten, by flow id. */
    readonly updatedFlowIds: readonly string[];
    /** How many node config values were filled in across all of them. */
    readonly writtenCount: number;
    /**
     * Targets that could not be resolved, with why.
     *
     * Returned rather than logged and dropped: a node left without its id produces a
     * block that fails at run time far from the cause, and the operator who just ran
     * an install is the right person to be told.
     */
    readonly unresolved: readonly UnresolvedTarget[];
}

export interface UnresolvedTarget extends ResourceBindingTarget {
    /**
     * `stale` means the binding names something deleted from the guild — re-running
     * install repairs it. `unbound` means no binding exists at all, which is what a
     * resource declared but never installed looks like.
     */
    readonly reason: 'stale' | 'unbound';
}

/**
 * Write a journey's provisioned ids into the flows that reference them.
 *
 * This is the half of "install writes snowflakes in" that had no caller. Install
 * records bindings; without this, every node that picked a declared resource keeps an
 * empty id and the flow cannot run — the builder's pending hint says exactly that, and
 * this is what clears it.
 *
 * **Scoped to the journey's own flows, and that scoping is load-bearing.** A resource
 * key is unique only *within* a journey — `resource_bindings` is keyed on the triple
 * `(guildId, journeyKey, resourceKey)` precisely so two journeys can each declare
 * `welcome-channel` and mean different channels. This function matches targets on the
 * bare key, so it must be told which flows are in scope or it will write one journey's
 * snowflake into another journey's flows.
 *
 * It did exactly that until 2026-09-22: the loop ran over every flow in the guild while
 * this comment claimed it was scoped. Nothing errored — the wrong channel id was simply
 * written into working flows, silently, on install. Grouping made it reachable in
 * earnest, so the filter below is now real rather than described.
 *
 * The flow set comes from the link table **plus** the pre-link convention (a journey
 * keyed on a flow's own id), mirroring `resolveFlowJourney`. Filtering on links alone
 * would skip a flow that predates the table and quietly stop filling in its ids — the
 * opposite failure, equally silent. That second branch goes when the fallback does.
 *
 * Note the dependency direction: this lives in flows and consumes the provisioning
 * barrel. Provisioning never imports flows.
 */
export async function applyResourcesToFlows(
    guild: Guild,
    journeyKey: string
): Promise<ApplyResourcesResult> {
    const { live, stale } = await resolveJourneyResources(guild, journeyKey);
    const staleKeys = new Set(stale);

    const flows = await flowsInJourney(guild.id, journeyKey);
    const updatedFlowIds: string[] = [];
    const unresolved: UnresolvedTarget[] = [];
    let writtenCount = 0;

    for (const flow of flows) {
        const targets = collectResourceTargets(flow.graph);
        if (targets.length === 0) continue;

        const result = bindResourcesToGraph(flow.graph, targets, live);

        for (const target of result.unresolved) {
            unresolved.push({
                ...target,
                reason: staleKeys.has(target.resourceKey) ? 'stale' : 'unbound',
            });
        }

        const written = targets.length - result.unresolved.length;
        if (written === 0) continue;

        // Only the graph is written. A flow's name and enabled state are the
        // operator's, and an install must not quietly flip a flow on because it
        // finally has its channels.
        await flowsRepo.update(flow.flowId, { graph: result.graph });
        updatedFlowIds.push(flow.flowId);
        writtenCount += written;
    }

    return { updatedFlowIds, writtenCount, unresolved };
}

/**
 * The flows a journey actually owns.
 *
 * Reads the guild's flows once and filters, rather than fetching per id: the link table
 * returns ids, and `flowsRepo` has no batch-by-id read. The guild's flow count is the
 * same order as the list this used to iterate blindly, so nothing is lost by it.
 *
 * `selectFlowIdsForJourney` holds the decision and is tested on its own.
 */
async function flowsInJourney(guildId: string, journeyKey: string) {
    const [flows, linkedFlowIds] = await Promise.all([
        flowsRepo.getByGuildId(guildId),
        flowJourneyLinksRepo.listFlowIdsForJourney(guildId, journeyKey),
    ]);

    const inScope = selectFlowIdsForJourney({
        journeyKey,
        linkedFlowIds,
        guildFlowIds: flows.map((flow) => flow.flowId),
    });

    return flows.filter((flow) => inScope.has(flow.flowId));
}

/**
 * Which flow ids a journey's install should write into.
 *
 * Pure, so the two branches can be pinned without a database — and they are worth
 * pinning separately, because they fail in opposite directions. Too wide writes another
 * journey's ids into working flows; too narrow leaves a flow's nodes holding empty
 * snowflakes after an install that reported success.
 */
export function selectFlowIdsForJourney(input: {
    readonly journeyKey: string;
    /** Flow ids with a link row naming this journey. Authoritative. */
    readonly linkedFlowIds: readonly string[];
    /** Every flow in the guild, for the pre-link fallback below. */
    readonly guildFlowIds: readonly string[];
}): ReadonlySet<string> {
    const selected = new Set(input.linkedFlowIds);

    /*
     * The pre-link convention: before `flow_journey_links` existed, a flow's journey was
     * keyed on the flow's own id. Such a flow has no link row, so it is admitted here by
     * the same rule `resolveFlowJourney` uses — but only when it is genuinely a flow in
     * this guild, never on the key alone. An operator may name a journey anything; a key
     * that happens to look like a flow id must not pull in a flow that never declared it.
     */
    if (input.guildFlowIds.includes(input.journeyKey)) {
        selected.add(input.journeyKey);
    }

    return selected;
}
