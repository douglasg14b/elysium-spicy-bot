import type { Guild } from 'discord.js';
import { resolveJourneyResources } from '../../provisioning';
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
 * Scoped to the journey's own flows. A journey key *is* a flow id for the implicit
 * case, but the lookup goes through every flow in the guild rather than assuming
 * that: a journey shared by several flows is the deferred grouping case, and writing
 * only to the flow whose id matched would silently skip the others the day it lands.
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

    const flows = await flowsRepo.getByGuildId(guild.id);
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
