import type { GuildTextBasedChannel, Message } from 'discord.js';
import { everyoneCanSee, type Viewers } from '../tools/visibleChannels';
import type { HistoryMessage } from './historyToModelMessages';

/** How many recent messages are read for context. */
export const HISTORY_MESSAGE_LIMIT = 40;

/** One message's text is capped so a wall of copypasta cannot crowd out the rest. */
const MESSAGE_CONTENT_LIMIT = 1_500;

/** Who will read the answer, and whether all of them may read history: the agent never shows the model more than they could scroll to. */
export type HistoryViewer = {
    readonly viewers: Viewers;
    readonly canReadHistory: boolean;
};

/**
 * The channel's recent messages, oldest first, as history, with `answering` marked.
 *
 * Read up to now rather than up to `answering`: a turn queued behind another must see the
 * reply the first one just posted. If `answering` has already scrolled out of the newest
 * messages (a long queue), the window ends at it instead.
 *
 * When anyone who will read the answer cannot read the channel's history, the agent gets
 * only the message being answered — the bot can read it, and must not summarise it for them.
 */
export async function readChannelHistory(
    channel: GuildTextBasedChannel,
    answering: Message<true>,
    botId: string,
    viewer: HistoryViewer
): Promise<HistoryMessage[]> {
    if (!viewer.canReadHistory) return [toHistoryMessage(answering, botId, viewer.viewers, answering.id)];

    const newest = await channel.messages.fetch({ limit: HISTORY_MESSAGE_LIMIT });
    const window = newest.has(answering.id)
        ? [...newest.values()]
        : [answering, ...(await channel.messages.fetch({ limit: HISTORY_MESSAGE_LIMIT, before: answering.id })).values()];
    return window
        .reverse()
        .filter((message) => !message.system)
        .map((message) => toHistoryMessage(message, botId, viewer.viewers, answering.id));
}

export function toHistoryMessage(
    message: Message,
    botId: string,
    viewers: Viewers,
    answeringId: string | undefined
): HistoryMessage {
    return {
        id: message.id,
        authorName: message.member?.displayName ?? message.author.displayName,
        isFromThisBot: message.author.id === botId,
        isFromOtherBot: message.author.bot && message.author.id !== botId,
        content: describeContent(message, viewers),
        createdAt: message.createdAt,
        replyToAuthorName: message.reference?.messageId ? message.mentions.repliedUser?.displayName : undefined,
        isBeingAnswered: message.id === answeringId,
    };
}

/**
 * The message as its readers would: mentions resolved to names — a channel only if every
 * viewer can see it — plus a note for each attachment and the
 * headline of each embed, since bots (and rules channels) often say everything in one.
 */
export function describeContent(message: Message, viewers: Viewers): string {
    const text = resolveMentions(message, viewers);
    const attachments = [...message.attachments.values()].map(
        (attachment) => `[attachment: ${attachment.name}${attachment.contentType ? `, ${attachment.contentType}` : ''}]`
    );
    const embeds = message.embeds
        .map((embed) => [embed.title, embed.description].filter(Boolean).join(' — '))
        .filter((summary) => summary.length > 0)
        .map((summary) => `[embed: ${summary}]`);
    const whole = [text, ...embeds, ...attachments].filter((part) => part.length > 0).join('\n');
    return whole.length > MESSAGE_CONTENT_LIMIT ? `${whole.slice(0, MESSAGE_CONTENT_LIMIT)} …[cut]` : whole;
}

function resolveMentions(message: Message, viewers: Viewers): string {
    return message.content
        .replace(/<@!?(\d+)>/g, (_match, userId: string) => {
            const member = message.mentions.members?.get(userId);
            const user = message.mentions.users.get(userId);
            return `@${member?.displayName ?? user?.displayName ?? 'someone'}`;
        })
        .replace(/<@&(\d+)>/g, (_match, roleId: string) => `@${message.mentions.roles.get(roleId)?.name ?? 'role'}`)
        .replace(/<#(\d+)>/g, (_match, channelId: string) => {
            const channel = viewers[0].guild.channels.cache.get(channelId);
            return channel && everyoneCanSee(viewers, channel) ? `#${channel.name}` : '#unknown-channel';
        })
        .replace(/<a?:(\w+):\d+>/g, (_match, emojiName: string) => `:${emojiName}:`)
        .trim();
}
