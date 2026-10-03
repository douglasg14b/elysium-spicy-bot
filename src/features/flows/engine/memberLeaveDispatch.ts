import type { GuildMember, PartialGuildMember } from 'discord.js';
import { flowsRepo } from '../data/flowsRepo';
import { isTriggerStartedBy } from '../blocks/registry';
import { startTriggeredRun } from './triggeredRun';
import type { FlowRunSeed } from '../blocks/types';

/**
 * On a member leaving, run **every** memberLeave trigger in every enabled flow in that
 * guild. Errors are isolated per trigger, exactly as joins are.
 *
 * `member` is partial whenever discord.js did not have the leaver cached — most of them
 * on a large server — which is why the client declares `Partials.GuildMember`. Without
 * it, discord.js drops the event for an uncached member and this never runs.
 *
 * Unlike a join, this wakes no parked runs. Nothing can park waiting on a departure —
 * `action.waitForEvent` does not offer one — and a run parked on anything else whose
 * member leaves fails on its own when it wakes, because resuming re-fetches the member.
 */
export async function handleMemberLeave(member: GuildMember | PartialGuildMember): Promise<void> {
    const flows = await flowsRepo.getByGuildId(member.guild.id);

    for (const flow of flows) {
        if (!flow.enabled) {
            continue;
        }

        const triggerNodes = flow.graph.nodes.filter((node) => isTriggerStartedBy(node.type, 'memberLeave'));

        for (const triggerNode of triggerNodes) {
            // A fresh seed per trigger, for the reason `handleMemberJoin` gives.
            const seed: FlowRunSeed = {
                client: member.client,
                guild: member.guild,
                subject: member,
                // No `actor`: someone kicked or banned did not cause their own leaving,
                // and the event cannot say which way they went. No `channel` either —
                // a departure happens nowhere in particular.
                variables: {},
            };

            await startTriggeredRun({
                flowId: flow.flowId,
                graph: flow.graph,
                triggerNodeId: triggerNode.id,
                source: 'memberLeave',
                seed,
            });
        }
    }
}
