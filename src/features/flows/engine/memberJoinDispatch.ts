import type { GuildMember } from 'discord.js';
import { flowsRepo } from '../data/flowsRepo';
import { TRIGGER_MEMBER_JOIN } from '../nodes/triggerMemberJoin';
import { executeFlow } from './executor';
import { resumeWaitingRunsForEvent } from './waitingRunDispatch';
import type { FlowRunContext } from '../nodes/types';

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

        const triggerNode = flow.graph.nodes.find((node) => node.type === TRIGGER_MEMBER_JOIN);
        if (!triggerNode) {
            continue;
        }

        const context: FlowRunContext = {
            client: member.client,
            guild: member.guild,
            member,
            user: member.user,
        };

        try {
            await executeFlow(flow.flowId, flow.graph, triggerNode.id, context);
        } catch (error) {
            console.error(`[flows] Unexpected error running memberJoin flow ${flow.flowId}:`, error);
        }
    }
}
