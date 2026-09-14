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

    // A reaction happens somewhere, and that somewhere is the run's channel. The
    // guard narrows rather than rejects: `message.channel` is typed for DMs too,
    // and an uncached partial can arrive without one at all. A run with no
    // channel is a real state the context already models, so the absent case
    // carries on rather than bailing out.
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

        const triggerNode = flow.graph.nodes.find((node) => {
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

        if (!triggerNode) {
            continue;
        }

        let member: GuildMember;
        try {
            member = await guild.members.fetch(user.id);
        } catch (error) {
            console.error(`[flows] Could not fetch member ${user.id} for reaction flow:`, error);
            return;
        }

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
            console.error(`[flows] Unexpected error running reactionAdd flow ${flow.flowId}:`, error);
        }
    }
}
