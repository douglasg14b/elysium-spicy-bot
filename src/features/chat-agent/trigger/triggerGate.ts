import { MessageType } from 'discord.js';
import type { Message } from 'discord.js';

/** What the gate needs to know about a message. */
export type TriggerFacts = {
    readonly inGuild: boolean;
    readonly isSystem: boolean;
    readonly authorIsBot: boolean;
    /** The bot is named in the text (`<@bot>`), not merely pinged by a reply. */
    readonly mentionsBot: boolean;
    /**
     * The message replies to something the chat agent itself said. A reply to any other bot
     * post — an onboarding question, ticket controls, a level-up — is not talking to the agent.
     */
    readonly repliesToChatAgent: boolean;
    /** The channel is a ticket. */
    readonly inTicket: boolean;
};

/** Why the agent was spoken to, or that it was not. */
export type Trigger = { readonly kind: 'mention' } | { readonly kind: 'replyToBot' } | { readonly kind: 'none' };

/**
 * Whether a message is addressed to the chat agent.
 *
 * In a ticket only an explicit mention counts: tickets are a member and the mods, and the
 * bot speaks there only when someone deliberately calls it in. Whether the mention is a
 * question it should answer at all is the agent's call (`stayQuiet`).
 */
export function resolveTrigger(facts: TriggerFacts): Trigger {
    if (!facts.inGuild || facts.isSystem || facts.authorIsBot) return { kind: 'none' };
    if (facts.mentionsBot) return { kind: 'mention' };
    if (facts.repliesToChatAgent && !facts.inTicket) return { kind: 'replyToBot' };
    return { kind: 'none' };
}

/** Could this message be for the bot at all? The cheap check, before any fetch or lookup. */
export function mightBeForBot(message: Message, botId: string): boolean {
    if (!message.inGuild() || message.system || message.author.bot) return false;
    return mentionsBotInText(message, botId) || repliesToBotAccount(message, botId);
}

/**
 * The message being replied to, and the message *it* answered — both fetched by the caller,
 * each null when absent or gone.
 */
export type RepliedTo = {
    readonly message: Message;
    readonly answered: Message | null;
};

/** Reads {@link TriggerFacts} off a message, given what it replies to and whether the channel is a ticket. */
export function readTriggerFacts(
    message: Message,
    botId: string,
    repliedTo: RepliedTo | null,
    inTicket: boolean
): TriggerFacts {
    return {
        inGuild: message.inGuild(),
        isSystem: message.system,
        authorIsBot: message.author.bot,
        mentionsBot: mentionsBotInText(message, botId),
        repliesToChatAgent: !!repliedTo && isChatAgentPost(repliedTo.message, repliedTo.answered, botId),
        inTicket,
    };
}

/**
 * Whether `post` is one the chat agent wrote: the bot's, a reply, **and an answer to a
 * message addressed to the bot** (a mention, or a reply to the bot). Every chat agent post
 * replies to the message it answers (`chatAgentHandler`'s `postReply`). Being a bot reply is
 * not enough on its own: other bot features reply too — `bot.ts`'s "hello there" answers a
 * message that never addressed the bot, and a reply to that is not talking to the agent.
 *
 * `answered` is null when the message it replied to is gone; then it cannot be told apart, and
 * it does not count.
 */
export function isChatAgentPost(post: Message, answered: Message | null, botId: string): boolean {
    if (post.author.id !== botId || post.type !== MessageType.Reply || !answered) return false;
    return mentionsBotInText(answered, botId) || repliesToBotAccount(answered, botId);
}

// A reply with its ping on puts the replied-to author in `mentions.users`, so the text is
// what tells a real mention from a reply ping.
function mentionsBotInText(message: Message, botId: string): boolean {
    return new RegExp(`<@!?${botId}>`).test(message.content);
}

// Discord names the replied-to author even when the reply's ping is off.
function repliesToBotAccount(message: Message, botId: string): boolean {
    return !!message.reference?.messageId && message.mentions.repliedUser?.id === botId;
}
