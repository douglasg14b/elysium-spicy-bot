import type { Guild, Message, MessageReaction, PartialMessageReaction, PartialUser, User } from 'discord.js';
import { activityEventsRepo, type RecordActivityEventInput } from './data/activityEventsRepo';
import { notifyActivity } from './activitySubscribers';

/**
 * The activity event a message records, or null when it is not activity.
 *
 * Activity when it is in a guild, not a system message, and not authored by a bot or a
 * webhook. Nothing else: in particular a `/`-prefixed message *is* activity — whether it
 * earns XP is leveling's rule, applied in leveling. `occurredAt` is the message's own
 * timestamp, so processing delay does not shift it.
 *
 * The one rule for both the live recorder and the startup backfill, so a recovered row
 * cannot differ from one recorded as it happened.
 */
export function toMessageActivity(message: Message): RecordActivityEventInput | null {
    if (!message.inGuild() || !message.guild || message.system || message.author.bot || message.webhookId) {
        return null;
    }

    return {
        guildId: message.guildId,
        userId: message.author.id,
        channelId: message.channelId,
        // A reply in a thread counts toward the channel the thread sits under.
        parentChannelId: message.channel.isThread() ? message.channel.parentId : null,
        messageId: message.id,
        kind: 'message',
        occurredAt: message.createdAt,
    };
}

/**
 * Record a guild message as activity, then notify the subscribers.
 *
 * What counts is {@link toMessageActivity}'s rule. A message the startup backfill already
 * recorded inserts nothing and notifies nobody: it is not a new event, and the
 * subscriber already had its one chance at it (which, for a backfilled row, was none).
 */
export async function recordMessageActivity(message: Message): Promise<void> {
    const input = toMessageActivity(message);
    // `inGuild()` again only to narrow `message` for the event below; `toMessageActivity` already required it.
    if (!input || !message.inGuild()) {
        return;
    }

    const activityEventId = await recordOrLog(input);
    if (activityEventId === null) return;

    await notifyActivity({
        kind: 'message',
        message,
        activityEventId,
        guild: message.guild,
        userId: input.userId,
        channelId: input.channelId,
        parentChannelId: input.parentChannelId,
    });
}

/**
 * Record a reaction as activity by the reactor, in the channel of the message reacted to.
 *
 * The reaction and its message may arrive partial, but a partial message still carries
 * `guildId` and `channelId` from the gateway event and the guild resolves from cache, so
 * nothing is fetched for them. Only a partial *user* is fetched, because the bot check
 * needs `bot`. A reaction carries no timestamp, so it occurred when it was received.
 *
 * Unlike leveling's old listener, a reaction on a message the bot cannot fetch (deleted,
 * no Read Message History) is still recorded, and so still reaches the subscriber.
 */
export async function recordReactionActivity(
    reaction: MessageReaction | PartialMessageReaction,
    user: User | PartialUser
): Promise<void> {
    const { message } = reaction;
    const guild = message.guild;
    if (!message.guildId || !guild) {
        return;
    }

    const reactor = await resolveReactionUser(user);
    if (!reactor || reactor.bot) {
        return;
    }

    const input: RecordActivityEventInput = {
        guildId: message.guildId,
        userId: reactor.id,
        channelId: message.channelId,
        parentChannelId: threadParentFromCache(guild, message.channelId),
        messageId: null,
        kind: 'reaction',
        occurredAt: new Date(),
    };

    const activityEventId = await recordOrLog(input);
    if (activityEventId === null) return;

    await notifyActivity({
        kind: 'reaction',
        activityEventId,
        guild,
        userId: input.userId,
        channelId: input.channelId,
    });
}

/**
 * Write the row and return its id, or `null` when there is nothing new to notify.
 *
 * Null when the message was already recorded (by the startup backfill), or when the
 * write failed. A failed write only happens when the database itself is failing, and
 * then any subscriber's own write would fail too — so it notifies nobody rather than
 * handing subscribers an event with no id to link to.
 */
async function recordOrLog(input: RecordActivityEventInput): Promise<number | null> {
    try {
        return await activityEventsRepo.record(input);
    } catch (error) {
        console.error(
            `[activity] Failed to record ${input.kind} activity (guild=${input.guildId} user=${input.userId}):`,
            error
        );
        return null;
    }
}

/**
 * The parent of the thread a reaction landed in, from cache alone.
 *
 * A reaction's message may be partial, and fetching its channel would cost a REST call
 * per reaction that the recorder deliberately stopped making. The guild's channel cache
 * holds every thread the bot has seen, so this answers for nearly all of them; a thread
 * it has never seen reads as null. Harmless where it matters: reactions never reset a
 * quiet timeout, which counts messages only.
 */
function threadParentFromCache(guild: Guild, channelId: string): string | null {
    const channel = guild.channels.cache.get(channelId);
    return channel?.isThread() ? channel.parentId : null;
}

async function resolveReactionUser(user: User | PartialUser): Promise<User | null> {
    if (!user.partial) {
        return user;
    }

    try {
        return await user.fetch();
    } catch (error) {
        console.warn('[activity] Failed to fetch partial reaction user:', error);
        return null;
    }
}
