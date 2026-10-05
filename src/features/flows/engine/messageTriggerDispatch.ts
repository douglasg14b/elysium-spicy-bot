import type { GuildMember, Message } from 'discord.js';
import type { MessageActivityEvent, RecordedActivityEvent } from '../../../features-system/activity';
import { MESSAGE_SENT_VARIABLES } from '../blocks/triggerMessageSent';
import { messageActivityLimit } from './messageActivityLimit';
import { messageTriggerIndex } from './messageTriggerIndex';
import { wakeMessageWaits } from './messageWaitDispatch';
import { asGuildTextChannel } from './runChannel';
import { startTriggeredRun, type SubjectSeed } from './triggeredRun';

/**
 * Everything flows does with one recorded message — the activity subscriber `initFlows`
 * registers.
 *
 * **Wake-ups first, then triggers, in that order and in one subscriber.** A run started
 * by this message that parks on a message wait must not be woken by the same message,
 * and two subscribers run in parallel, so the order is held here rather than left to
 * them. A fault waking runs is logged and does not stop the triggers.
 *
 * Reactions are ignored.
 */
export async function handleMessage(event: RecordedActivityEvent): Promise<void> {
    if (event.kind !== 'message') return;

    try {
        await wakeMessageWaits(event);
    } catch (error) {
        console.error(`[flows] Could not wake the runs waiting on message ${event.message.id}:`, error);
    }

    await startMessageTriggers(event);
}

/**
 * Start a run from every enabled Message Sent trigger this message matches.
 *
 * Matched against the guild's in-memory trigger index — no database read once the guild
 * is loaded — by where it was posted, then by the trigger's text, lower-cased on both
 * sides. Where counts a thread reply toward the channel it sits under, and a channel
 * toward its category, both read from discord.js's cache at the moment of the message:
 * a channel moved into a category matches it from then on, with nothing reloaded.
 *
 * Each run:
 *
 *  - is about, and was caused by, the poster — `message.member`, or fetched when the
 *    message arrived without one. A member who cannot be fetched starts nothing.
 *  - operates in the channel posted in, so its replies land in the thread.
 *  - carries both of the trigger's outputs, always set: the channel the message belongs
 *    to (a thread's parent) and the place it was posted.
 *  - carries when the message was sent, so a message wait it parks on starts listening
 *    after this message even when Discord's clock runs ahead of the bot's.
 *  - draws one token from the message flood limit, checked only once a trigger has
 *    matched, so a message that matches nothing spends nothing. A refused run is dropped.
 */
export async function startMessageTriggers(event: MessageActivityEvent): Promise<void> {
    const triggers = await messageTriggerIndex.forGuild(event.guild.id);
    if (!triggers || triggers.isEmpty) return;

    const { message } = event;
    const content = message.content.toLowerCase();
    const matching = triggers
        .matching({ channelId: event.channelId, parentChannelId: event.parentChannelId, categoryId: categoryOf(message) })
        .filter((entry) => !entry.text || content.includes(entry.text));
    if (matching.length === 0) return;

    const member = await memberOf(event);
    if (!member) return;

    const channel = asGuildTextChannel(message.channel);
    for (const entry of matching) {
        // A fresh seed per run, as every dispatcher builds one. Names its member, since
        // the flood limit counts starts per member.
        const seed: SubjectSeed = {
            client: message.client,
            guild: event.guild,
            subject: member,
            actor: member,
            channel,
            variables: {
                [MESSAGE_SENT_VARIABLES.channel]: event.parentChannelId ?? event.channelId,
                [MESSAGE_SENT_VARIABLES.postedIn]: event.channelId,
            },
            eventAt: message.createdAt,
        };

        await startTriggeredRun({
            flowId: entry.flowId,
            graph: entry.graph,
            triggerNodeId: entry.nodeId,
            source: 'messageSent',
            seed,
            limit: messageActivityLimit,
        });
    }
}

/**
 * The category the message's channel sits in, from cache: the channel's own parent, or
 * for a thread reply, the parent of the channel the thread is under.
 */
function categoryOf(message: Message<true>): string | null {
    const { channel } = message;
    return channel.isThread() ? (channel.parent?.parentId ?? null) : channel.parentId;
}

/** Who posted, as a member: on the message already, or fetched; null when neither works. */
async function memberOf(event: MessageActivityEvent): Promise<GuildMember | null> {
    if (event.message.member) return event.message.member;

    try {
        return await event.guild.members.fetch(event.userId);
    } catch (error) {
        console.warn(
            `[flows] Skipping Message Sent triggers for ${event.userId} in guild ${event.guild.id}: member could not be fetched`,
            error
        );
        return null;
    }
}
