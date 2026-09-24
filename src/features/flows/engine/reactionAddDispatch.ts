import { GuildMember, type MessageReaction, type PartialMessageReaction, type PartialUser, type User } from 'discord.js';
import { flowsRepo } from '../data/flowsRepo';
import { isTriggerStartedBy } from '../blocks/registry';
import { reactionAddConfigSchema } from '../blocks/triggerReactionAdd';
import { executeFlow } from './executor';
import { asGuildTextChannel } from './runChannel';
import { resumeWaitingRunsForEvent } from './waitingRunDispatch';
import type { FlowRunSeed } from '../blocks/types';

/**
 * True when a reaction's emoji matches the configured value. Accepts a unicode
 * emoji ("🌶️"), a custom emoji's id ("123456789"), or its name ("spicy") so the
 * builder can store whichever form the admin picked.
 */
export function reactionMatchesEmoji(
    reaction: MessageReaction | PartialMessageReaction,
    configured: string
): boolean {
    const { id, name } = reaction.emoji;
    return configured === id || configured === name;
}

/**
 * On a reaction add, run every enabled flow in that guild whose reactionAdd
 * trigger matches the channel + message + emoji, AND wake any durable run parked
 * on an `action.waitForEvent` node awaiting a reaction from this user. Errors are
 * isolated per flow so one bad flow cannot block the others or crash the
 * listener.
 *
 * Reactions on old (uncached) messages arrive partial — both the reaction and
 * the user are fetched before matching.
 */
export async function handleReactionAdd(
    reaction: MessageReaction | PartialMessageReaction,
    user: User | PartialUser
): Promise<void> {
    if (user.bot) {
        return;
    }

    if (reaction.partial) {
        try {
            await reaction.fetch();
        } catch (error) {
            console.error('[flows] Could not fetch partial reaction:', error);
            return;
        }
    }

    const guild = reaction.message.guild;
    if (!guild) {
        return;
    }

    // A reaction happens somewhere, and that somewhere is the run's channel.
    //
    // **The channel is always cached by the time this runs**, so there is nothing
    // to fetch. `MessageReactionAdd` resolves it through `Action.getChannel`,
    // which — without `Partials.Channel`, and `discordClient.ts` enables only
    // `Message` and `Reaction` — reads `client.channels.cache.get(id)` and
    // returns `false` from `handle` when that misses. An uncached channel means
    // the event is dropped upstream and this dispatcher is never called at all.
    //
    // So the narrowing is the only work left, and it still earns its place: it
    // rejects a DM (where a guild run cannot post) and a forum or media parent
    // (which holds threads rather than messages). `trigger.reactionAdd` declares
    // `requires: ['channel']` and save-time validation treats a declaring trigger
    // as a *supplier*, so what matters is that the requirement is met by a channel
    // a run can actually use, or reported absent — never by a narrowing that
    // quietly failed.
    //
    // Do not add a `client.channels.fetch` fallback here: it cannot be reached,
    // and it would put a REST call on a path that runs for every reaction in the
    // guild. If reactions on uncached channels ever need to work, the owner of
    // that is `Partials.Channel` in `discordClient.ts`, not a branch here.
    const reactionChannel = asGuildTextChannel(reaction.message.channel);

    await resumeWaitingRunsForEvent(reaction.client, {
        guildId: guild.id,
        userId: user.id,
        eventKind: 'reactionAdd',
    });

    const flows = await flowsRepo.getByGuildId(guild.id);

    for (const flow of flows) {
        if (!flow.enabled) {
            continue;
        }

        /*
         * **Every** matching trigger, not the first.
         *
         * This was `.find()`, which meant a flow holding two triggers that both match
         * this reaction ran exactly one of them — picked by position in `graph.nodes`,
         * i.e. the order the author happened to drop them on the canvas. The other
         * branch was silently dead: nothing logged it, no validation mentioned it, and
         * the canvas showed two live-looking triggers.
         *
         * Each is its own run. `executeFlow` already takes the trigger's node id and
         * threads it through the run record, so two entry points into one graph are
         * two runs that can be told apart afterwards — nothing here had to be invented
         * to support that.
         */
        const triggerNodes = flow.graph.nodes.filter((node) => {
            if (!isTriggerStartedBy(node.type, 'reactionAdd')) {
                return false;
            }
            const parsed = reactionAddConfigSchema.safeParse(node.data);
            if (!parsed.success) {
                return false;
            }
            return (
                parsed.data.channelId === reaction.message.channelId &&
                parsed.data.messageId === reaction.message.id &&
                reactionMatchesEmoji(reaction, parsed.data.emoji)
            );
        });

        if (triggerNodes.length === 0) {
            continue;
        }

        let member: GuildMember;
        try {
            member = await guild.members.fetch(user.id);
        } catch (error) {
            // `continue`, never `return`. This was a `return`, so one member the bot
            // could not resolve — someone who left between reacting and the event
            // landing — abandoned dispatch for every *remaining flow in the guild*,
            // stepping straight over the per-flow isolation the catch below exists to
            // provide.
            console.error(`[flows] Could not fetch member ${user.id} for reaction flow:`, error);
            continue;
        }

        for (const triggerNode of triggerNodes) {
            /*
             * A fresh seed per trigger, built inside the loop.
             *
             * Sharing one object across both runs happens to be safe today —
             * `executeFlowSegment` re-bags `variables` through `emptyBagWith` on the
             * way in and reassigns rather than mutating — but that is a property of
             * the *executor*, and relying on it here would make two runs' isolation
             * depend on a guarantee this file neither states nor owns. Two runs get
             * two seeds; the object costs nothing.
             */
            const context: FlowRunSeed = {
                client: reaction.client,
                guild,
                // The reacting member both is who the run is about and caused it.
                subject: member,
                actor: member,
                channel: reactionChannel,
                variables: {},
            };

            try {
                await executeFlow(flow.flowId, flow.graph, triggerNode.id, context);
            } catch (error) {
                // Isolated per *trigger*, not just per flow: two entry points into one
                // graph are as independent as two flows, so one throwing must not
                // strand the other.
                console.error(
                    `[flows] Unexpected error running reactionAdd flow ${flow.flowId} from ${triggerNode.id}:`,
                    error
                );
            }
        }
    }
}
