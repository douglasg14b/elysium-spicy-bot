import type { Guild } from 'discord.js';
import { resolveJourneyResources } from '../../provisioning';
import { flowsRepo } from '../data/flowsRepo';
import { bindResourcesToGraph, type ResourceBindingTarget } from './bindResourcesToGraph';
import { flowsInJourney } from './journeyMembership';
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
 * key is unique only *within* a journey — `resource_bindings` is keyed on
 * `(guildId, ownerKind, ownerKey, resourceKey)` precisely so two journeys can each declare
 * `welcome-channel` and mean different channels. This function matches targets on the
 * bare key, so it must be told which flows are in scope or it will write one journey's
 * snowflake into another journey's flows.
 *
 * It did exactly that until 2026-09-22: the loop ran over every flow in the guild while
 * this comment claimed it was scoped. Nothing errored — the wrong channel id was simply
 * written into working flows, silently, on install. Grouping made it reachable in
 * earnest, so the filter below is now real rather than described.
 *
 * The flow set is `flowsInJourney`'s: a flow is in the journey only when
 * `resolveFlowJourney` would say so — its link row, or, with no link row at all, the
 * pre-link convention of a journey keyed on its own id. Filtering on links alone would skip
 * a flow that predates the table and quietly stop filling in its ids; admitting a flow by
 * its id while it is linked elsewhere — the rule here until step 3 — wrote this journey's
 * ids into a flow that had been grouped away from it.
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
        //
        // Exempt from the loop check a live flow's save faces (`findFlowCycleThrough`) —
        // and not because a write here cannot add a link between flows. Since a journey
        // can declare a ticket type, it can: an Open Ticket waiting on a declared type has
        // an empty `ticketType` and emits nothing, and once this fills in the key it emits
        // that type's ticket changes, which a Ticket Event trigger elsewhere may listen for.
        //
        // The exemption holds because no flow this writes into can be live while it
        // waits. A flow with a declared key still uninstalled is refused at switch-on
        // (`uninstalledResourceKeys`), so it is off when this runs; turning it on
        // afterwards goes through `decidePut`, which runs `findFlowCycleThrough` against
        // the graph as it stands now, ids filled in. The loop is caught there, at the one
        // moment it could start running.
        //
        // Not covered: a live flow whose field already holds one type while its sidecar
        // names another. This overwrites the field with the sidecar's key without asking
        // the loop check. No builder control produces that pair — picking a guild type
        // clears the sidecar — so it takes a hand-made API call; recorded, not handled.
        await flowsRepo.update(flow.flowId, { graph: result.graph });
        updatedFlowIds.push(flow.flowId);
        writtenCount += written;
    }

    return { updatedFlowIds, writtenCount, unresolved };
}
