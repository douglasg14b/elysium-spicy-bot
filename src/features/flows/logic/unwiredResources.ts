import type { Guild } from 'discord.js';
import { resolveJourneyResources } from '../../provisioning';
import type { JourneyDeclaration } from '../../provisioning/logic/resourceDeclaration';
import type { FlowGraph } from '../data/flowGraph';
import { uninstalledResourceKeys } from './flowReadiness';

/**
 * The declared resources a flow's blocks pick that are already in the server but not yet
 * written into those blocks.
 *
 * A block picking a declared resource keeps its name and leaves the id empty; only an
 * install's write-back (`applyResourcesToFlows`) fills it in. When the resource is bound
 * already — installed with the rest, or adopted — the install plan has nothing to create,
 * so the dashboard offered no install and nothing would ever fill the id: the flow could
 * not be switched on. These are the keys that install can still wire up.
 *
 * Keys the flow waits on that are not bound are left out: those are the plan's own items.
 */
export async function unwiredResourceKeys(
    guild: Guild,
    journey: JourneyDeclaration,
    graph: FlowGraph
): Promise<readonly string[]> {
    const waiting = uninstalledResourceKeys(graph, journey.resources);
    if (waiting.length === 0) return [];

    const { live } = await resolveJourneyResources(guild, journey.journeyKey);
    return waiting.filter((key) => live.has(key));
}
