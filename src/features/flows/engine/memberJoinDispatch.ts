import type { GuildMember } from 'discord.js';
import { flowsRepo } from '../data/flowsRepo';
import { isTriggerStartedBy } from '../blocks/registry';
import { executeFlow } from './executor';
import { resumeWaitingRunsForEvent } from './waitingRunDispatch';
import type { FlowRunSeed } from '../blocks/types';

/**
 * On a member join, run **every** memberJoin trigger in every enabled flow in that
 * guild, AND wake any durable run parked on an `action.waitForEvent` node awaiting
 * this member's join. Errors are isolated per trigger, so neither a bad flow nor one
 * bad entry point within a flow can block the others or crash the listener.
 *
 * "Every trigger" rather than "the flow's first trigger" is the correction here: this
 * used `.find()`, so a flow holding two memberJoin triggers ran one of them, chosen by
 * position in `graph.nodes` — the order the author happened to drop them on the canvas.
 * The other was silently dead, with nothing logged and nothing on the canvas to show it.
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

        const triggerNodes = flow.graph.nodes.filter((node) =>
            isTriggerStartedBy(node.type, 'memberJoin')
        );

        for (const triggerNode of triggerNodes) {
            /*
             * A fresh seed per trigger. Sharing one would survive today's executor,
             * which re-bags `variables` on the way in, but that is the executor's
             * guarantee rather than this file's — and two runs' isolation should not
             * rest on a property stated somewhere else.
             */
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
                // Per trigger, not just per flow: two entry points into one graph are
                // as independent as two flows, so one throwing must not strand the
                // other.
                console.error(
                    `[flows] Unexpected error running memberJoin flow ${flow.flowId} from ${triggerNode.id}:`,
                    error
                );
            }
        }
    }
}
