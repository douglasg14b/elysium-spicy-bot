import type { LevelUpEvent } from '../../leveling';
import { flowsRepo } from '../data/flowsRepo';
import { isTriggerStartedBy } from '../blocks/registry';
import { LEVEL_REACHED_VARIABLES, levelReachedConfigSchema } from '../blocks/triggerLevelReached';
import { executeFlow } from './executor';
import type { FlowRunSeed } from '../blocks/types';

/**
 * On a level-up, run **every** levelReached trigger whose configured level matches, in
 * every enabled flow in that guild.
 *
 * Modelled on `reactionAddDispatch`: the registry answers which triggers this source
 * starts, and the trigger's own schema is then used to decide whether this particular
 * event matches. That second half is the residual debt recorded in
 * `__tests__/blockTypeBranching.test.ts` — generic selection, block-specific matching —
 * and a numeric threshold incurs it the same way a channel/emoji pair does.
 *
 * Errors are isolated per trigger, so neither a bad flow nor one bad entry point within a
 * flow can block the others. Nothing awaits this dispatcher's result: `notifyLevelUp`
 * swallows what it throws, so a flow failure cannot cost a member the XP they earned.
 */
export async function handleLevelUp(event: LevelUpEvent): Promise<void> {
    /*
     * Resolved once, outside the flow loop. A level-up names a user id rather than a
     * member — leveling holds no member object — and every matching trigger needs the
     * same one as its subject.
     *
     * `fetch` rather than `cache.get`: XP is granted from gateway events for members who
     * may not be cached, and a cache miss here would silently drop the whole dispatch.
     */
    const member = await event.guild.members.fetch(event.userId).catch(() => null);

    if (!member) {
        console.warn(
            `[flows] Skipping levelUp dispatch for ${event.userId} in guild ${event.guild.id}: member could not be fetched`
        );
        return;
    }

    const flows = await flowsRepo.getByGuildId(event.guild.id);

    for (const flow of flows) {
        if (!flow.enabled) {
            continue;
        }

        const triggerNodes = flow.graph.nodes.filter((node) => {
            if (!isTriggerStartedBy(node.type, 'levelUp')) {
                return false;
            }

            const parsed = levelReachedConfigSchema.safeParse(node.data);
            if (!parsed.success) {
                // An unconfigured or half-configured trigger matches nothing rather than
                // everything: firing on every level because no level was set would be a
                // surprise the author never asked for.
                return false;
            }

            return parsed.data.level === event.level;
        });

        for (const triggerNode of triggerNodes) {
            /*
             * A fresh seed per trigger. Sharing one would survive today's executor, which
             * re-bags `variables` on the way in, but that is the executor's guarantee
             * rather than this file's.
             */
            const context: FlowRunSeed = {
                client: event.guild.client,
                guild: event.guild,
                // Levelling up is something the member did, so they are the actor as well
                // as the subject — the same reading `memberJoinDispatch` takes for a join.
                subject: member,
                actor: member,
                // No `channel`: a level-up happens nowhere in particular.
                /*
                 * Seeded here rather than written by the trigger's `run`, because the run
                 * has no access to the event — this dispatcher is the only thing that
                 * knows which level was reached.
                 *
                 * The *keys* come from the block, which is also what declares them as
                 * `outputs`, so the picker and the bag cannot disagree. Computed keys
                 * rather than literals for the same reason `engine/` declares no domain
                 * nouns of its own: the interpreter moves these values without learning
                 * what they are called.
                 */
                variables: {
                    [LEVEL_REACHED_VARIABLES.level]: event.level,
                    [LEVEL_REACHED_VARIABLES.totalXp]: event.totalXp,
                },
            };

            try {
                await executeFlow(flow.flowId, flow.graph, triggerNode.id, context);
            } catch (error) {
                // Per trigger, not just per flow: two entry points into one graph are as
                // independent as two flows, so one throwing must not strand the other.
                console.error(
                    `[flows] Unexpected error running levelUp flow ${flow.flowId} from ${triggerNode.id}:`,
                    error
                );
            }
        }
    }
}
