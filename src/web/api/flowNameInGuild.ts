import { flowsRepo } from '../../features/flows/data/flowsRepo';

/**
 * A flow's name, for a refusal an operator has to act on.
 *
 * A UUID identifies the row but tells an operator nothing about which flow on their
 * canvas to go and detach, so every refusal that names flows resolves names through
 * this.
 *
 * **Guild-scoped, which `flowsRepo.getByFlowId` is not** — it matches on `flowId`
 * alone. The link rows these ids come from are already guild-scoped, so a foreign flow
 * should not be reachable; but the name is about to be placed in a response body, and
 * confirming the guild is cheaper than reasoning about whether every future caller
 * preserved that property.
 *
 * Lives here rather than in `provisioning/logic/` because it reads the flows repo, and
 * provisioning must never import flows. The guard takes it as a callback for exactly
 * that reason.
 */
export async function flowNameInGuild(guildId: string, flowId: string): Promise<string | undefined> {
    const flow = await flowsRepo.getByFlowId(flowId);
    return flow && flow.guildId === guildId ? flow.name : undefined;
}
