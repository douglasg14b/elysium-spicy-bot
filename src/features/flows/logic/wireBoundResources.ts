import type { Guild } from 'discord.js';
import { resolveJourneyResources } from '../../provisioning';
import type { FlowGraph } from '../data/flowGraph';
import { bindResourcesToGraph } from './bindResourcesToGraph';
import { collectResourceTargets } from './resourceTargets';

/**
 * A graph arriving to be saved, with the ids of its journey's bound resources written into
 * the blocks that picked them — what an install's write-back (`applyResourcesToFlows`) does
 * to the stored flow, done to the save instead.
 *
 * The builder never holds those ids. Its picker blanks the id whenever a declared resource
 * is picked, installed or not, and its canvas is not reloaded after an install fills them
 * into the stored flow — so each save sent the empty id back over the wired one, and a live
 * flow's save went to a draft "until it is installed", every time. Filled here, a save says
 * what the flow picked and the server supplies what that is in this guild.
 *
 * A key with no live binding is left as it arrived: waiting on its install, which the save's
 * own rules handle. Reads the bindings table, so a caller holding a transaction must call
 * this before it. Needs the block registry, as `collectResourceTargets` does.
 */
export async function wireBoundResources(guild: Guild, journeyKey: string, graph: FlowGraph): Promise<FlowGraph> {
    const targets = collectResourceTargets(graph);
    if (targets.length === 0) return graph;

    const { live } = await resolveJourneyResources(guild, journeyKey);
    return bindResourcesToGraph(graph, targets, live).graph;
}
