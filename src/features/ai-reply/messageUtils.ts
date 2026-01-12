import { Message, TextChannel } from 'discord.js';
import { AI_MAX_CONTEXT_MESSAGES } from '../../environment';
import type { MessageContext } from './aiService';

const MAX_AI_CONTEXT_CHARACTERS = 4000;

export async function fetchRecentMessages(
    channel: TextChannel,
    beforeMessage?: Message,
    limit: number = AI_MAX_CONTEXT_MESSAGES
): Promise<MessageContext[]> {
    try {
        const fetchOptions: { limit: number; before?: string } = { limit };

        if (beforeMessage) {
            fetchOptions.before = beforeMessage.id;
        }

        const messages = await channel.messages.fetch(fetchOptions);
        const reversed = messages.map((msg) => mapDiscordMessageToContext(msg)).reverse(); // Return in chronological order (oldest first)
        const pruned = pruneHistoryToFitLimit(reversed);
        console.log(`Fetched ${pruned.length} recent messages for AI context (originally ${messages.size})`);
        return pruned;
    } catch (error) {
        console.error('Error fetching recent messages:', error);
        return [];
    }
}

function pruneHistoryToFitLimit(history: MessageContext[]): MessageContext[] {
    let totalCharacters = 0;
    const prunedHistory: MessageContext[] = [];

    for (let i = 0; i < history.length; i++) {
        const message = history[i];
        const messageLength = message.content.length;

        if (totalCharacters + messageLength <= MAX_AI_CONTEXT_CHARACTERS) {
            prunedHistory.push(message);
            totalCharacters += messageLength;
        } else {
            break; // Stop adding messages once we exceed the limit
        }
    }

    return prunedHistory;
}

export function mapDiscordMessageToContext(msg: Message): MessageContext {
    return {
        author: msg.author.displayName || msg.author.username,
        content: cleanMessageContent(msg),
        timestamp: msg.createdAt,
        isFromBot: msg.author.bot,
        isReply: !!msg.reference,
        replyToAuthor: msg.reference
            ? msg.mentions.repliedUser?.displayName || msg.mentions.repliedUser?.username
            : undefined,
    };
}

function cleanMessageContent(message: Message): string {
    let content = message.content;

    // Replace user mentions with actual usernames
    content = content.replace(/<@!?(\d+)>/g, (match, userId) => {
        const user = message.mentions.users.get(userId);
        return user ? `@${user.displayName || user.username}` : '@user';
    });

    // Replace role mentions with actual role names
    content = content.replace(/<@&(\d+)>/g, (match, roleId) => {
        const role = message.mentions.roles.get(roleId);
        return role ? `@${role.name}` : '@role';
    });

    // Replace channel mentions with actual channel names
    content = content.replace(/<#(\d+)>/g, (match, channelId) => {
        const channel = message.mentions.channels.get(channelId);
        if (channel && 'name' in channel && channel.name) {
            return `#${channel.name}`;
        }
        return '#channel';
    });

    // Replace custom emojis with their names
    content = content.replace(/<a?:(\w+):\d+>/g, (match, emojiName) => {
        return `:${emojiName}:`;
    });

    return content.trim();
}

export function shouldRespondToMessage(message: Message, botId: string): boolean {
    // Don't respond to bot's own messages
    if (message.author.bot) {
        return false;
    }

    // Check if the bot is mentioned
    if (message.mentions.users.has(botId)) {
        return true;
    }

    // Check if this is a reply to one of the bot's messages
    if (message.reference && message.reference.messageId) {
        // We'll validate the referenced message is from the bot in the handler
        return true;
    }

    return false;
}

export async function isReplyToBotMessage(message: Message, botId: string): Promise<boolean> {
    if (!message.reference || !message.reference.messageId) {
        return false;
    }

    try {
        const channel = message.channel;
        if (!channel.isTextBased()) {
            return false;
        }

        const referencedMessage = await channel.messages.fetch(message.reference.messageId);
        return referencedMessage.author.id === botId;
    } catch (error) {
        console.error('Error checking if reply is to bot message:', error);
        return false;
    }
}

export async function isReplyToNonBotMessageWIthBotCallout(message: Message, botId: string): Promise<boolean> {
    if (!message.reference || !message.reference.messageId) {
        return false;
    }

    try {
        const channel = message.channel;
        if (!channel.isTextBased()) {
            return false;
        }

        const referencedMessage = await channel.messages.fetch(message.reference.messageId);
        const isReplyToNonBot = referencedMessage.author.id !== botId;
        const mentionsBot = message.mentions.users.has(botId);

        return isReplyToNonBot && mentionsBot;
    } catch (error) {
        console.error('Error checking if reply is to non-bot message with bot callout:', error);
        return false;
    }
}

export function extractMentionContent(message: Message, botId: string): string {
    // Remove the bot mention from the message content
    return message.content.replace(new RegExp(`<@!?${botId}>`, 'g'), '').trim();
}
