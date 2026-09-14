import type { GuildMember } from 'discord.js';
import { flowsRepo } from '../data/flowsRepo';
import { isTriggerStartedBy } from '../blocks/registry';
import { executeFlow } from './executor';
import { resumeWaitingRunsForEvent } from './waitingRunDispatch';
import type { FlowRunSeed } from '../blocks/types';

/**
 * On a member join, run every enabled flow in that guild whose first node is a
 * memberJoin trigger, AND wake any durable run parked on an `action.waitForEvent`
 * node awaiting this member's join. Errors are isolated per flow so one bad flow
 * cannot block the others or crash the listener.
 */
export async function handleMemberJoin(member: GuildMember): Promise<void> {
    await resumeWaitingRunsForEvent(member.client, {
        guildId: member.guild.id,
        userId: member.id,
        eventKind: 'memberJoin',
    });

    const flows = await flowsRepo.getByGuildId(member.guild.id);

    for (const flow of flows) {
        if (!flow.enabled) {
            continue;
        }

        const triggerNode = flow.graph.nodes.find((node) => isTriggerStartedBy(node.type, 'memberJoin'));
        if (!triggerNode) {
            continue;
        }

        const context: FlowRunSeed = {
            client: member.client,
            guild: member.guild,
            // A join *is* caused by the member joining, so they are the actor as
            // well as the subject. Reporting no actor here would be a lie about
            // what happened.
            subject: member,
            actor: member,
            // No `channel`: a join happens nowhere in particular, so there is
            // none to establish.
            variables: {},
        };

        try {
            await executeFlow(flow.flowId, flow.graph, triggerNode.id, context);
        } catch (error) {
            console.error(`[flows] Unexpected error running memberJoin flow ${flow.flowId}:`, error);
        }
    }
}
