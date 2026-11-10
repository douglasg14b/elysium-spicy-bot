import { describe, expect, it } from 'vitest';
import { MessageType } from 'discord.js';
import type { Message } from 'discord.js';
import { isChatAgentPost, readTriggerFacts, resolveTrigger, type TriggerFacts } from '../triggerGate';

const AN_ORDINARY_MESSAGE: TriggerFacts = {
    inGuild: true,
    isSystem: false,
    authorIsBot: false,
    mentionsBot: false,
    repliesToChatAgent: false,
    inTicket: false,
};

describe('resolveTrigger', () => {
    it('ignores a message that neither mentions nor replies to the bot', () => {
        expect(resolveTrigger(AN_ORDINARY_MESSAGE)).toEqual({ kind: 'none' });
    });

    it('answers a mention', () => {
        expect(resolveTrigger({ ...AN_ORDINARY_MESSAGE, mentionsBot: true })).toEqual({ kind: 'mention' });
    });

    it('answers a reply to something the chat agent said', () => {
        expect(resolveTrigger({ ...AN_ORDINARY_MESSAGE, repliesToChatAgent: true })).toEqual({ kind: 'replyToBot' });
    });

    it('calls a reply that also names the bot a mention', () => {
        expect(resolveTrigger({ ...AN_ORDINARY_MESSAGE, mentionsBot: true, repliesToChatAgent: true })).toEqual({
            kind: 'mention',
        });
    });

    it('in a ticket, answers only an explicit mention — never a reply', () => {
        const inTicket = { ...AN_ORDINARY_MESSAGE, inTicket: true };
        expect(resolveTrigger({ ...inTicket, repliesToChatAgent: true })).toEqual({ kind: 'none' });
        expect(resolveTrigger({ ...inTicket, mentionsBot: true })).toEqual({ kind: 'mention' });
    });

    it.each([
        ['another bot', { authorIsBot: true }],
        ['a system message', { isSystem: true }],
        ['a DM', { inGuild: false }],
    ] as const)('never answers %s, even when it mentions the bot', (_label, override) => {
        expect(resolveTrigger({ ...AN_ORDINARY_MESSAGE, mentionsBot: true, ...override })).toEqual({ kind: 'none' });
    });
});

const BOT_ID = '900000000000000001';

/** The parts of a discord.js message the gate reads, as Discord fills them in. */
function messageWith(
    content: string,
    extra: { authorId?: string; type?: MessageType; repliesToUserId?: string } = {}
): Message {
    return {
        content,
        system: false,
        type: extra.type ?? MessageType.Default,
        author: { id: extra.authorId ?? 'someone', bot: extra.authorId === BOT_ID },
        reference: extra.repliesToUserId ? { messageId: 'earlier' } : null,
        mentions: { repliedUser: extra.repliesToUserId ? { id: extra.repliesToUserId } : null },
        inGuild: () => true,
    } as unknown as Message;
}

/** A member's question that @s the bot, and the chat agent's answer to it. */
const QUESTION = messageWith(`<@${BOT_ID}> can I DM people?`);
const CHAT_AGENT_POST = messageWith('Ask first. Rule three.', { authorId: BOT_ID, type: MessageType.Reply });
/** What other features post as the bot: a plain message — an onboarding question, ticket controls. */
const ONBOARDING_QUESTION = messageWith('What pronouns do you use?', { authorId: BOT_ID });
/** `bot.ts`'s easter egg: a bot *reply*, but to a message that never addressed the bot. */
const HELLO_THERE = messageWith('hello there');
const GENERAL_KENOBI = messageWith('Why hello there!', { authorId: BOT_ID, type: MessageType.Reply });

describe('isChatAgentPost', () => {
    it('is a bot reply answering a message addressed to the bot', () => {
        expect(isChatAgentPost(CHAT_AGENT_POST, QUESTION, BOT_ID)).toBe(true);
        const replyToAgent = messageWith('and?', { repliesToUserId: BOT_ID });
        expect(isChatAgentPost(CHAT_AGENT_POST, replyToAgent, BOT_ID)).toBe(true);
    });

    it("is not the bot's other posts: plain ones, or replies to messages that never addressed it", () => {
        expect(isChatAgentPost(ONBOARDING_QUESTION, null, BOT_ID)).toBe(false);
        expect(isChatAgentPost(GENERAL_KENOBI, HELLO_THERE, BOT_ID)).toBe(false);
        expect(isChatAgentPost(messageWith('hi', { type: MessageType.Reply }), QUESTION, BOT_ID)).toBe(false);
    });

    it('does not count a bot reply whose answered message is gone, since it cannot be told apart', () => {
        expect(isChatAgentPost(CHAT_AGENT_POST, null, BOT_ID)).toBe(false);
    });
});

describe('readTriggerFacts', () => {
    it('reads <@bot> and <@!bot> in the text as a mention', () => {
        expect(readTriggerFacts(messageWith(`hey <@${BOT_ID}> you up`), BOT_ID, null, false).mentionsBot).toBe(true);
        expect(readTriggerFacts(messageWith(`<@!${BOT_ID}>`), BOT_ID, null, false).mentionsBot).toBe(true);
    });

    it('answers a reply to the chat agent, ping or no ping', () => {
        const facts = readTriggerFacts(messageWith('lol'), BOT_ID, { message: CHAT_AGENT_POST, answered: QUESTION }, false);
        expect(facts).toMatchObject({ mentionsBot: false, repliesToChatAgent: true });
        expect(resolveTrigger(facts)).toEqual({ kind: 'replyToBot' });
    });

    it("ignores a reply to the bot's automated posts, like an onboarding question or ticket controls", () => {
        const facts = readTriggerFacts(messageWith('they/them'), BOT_ID, { message: ONBOARDING_QUESTION, answered: null }, false);
        expect(resolveTrigger(facts)).toEqual({ kind: 'none' });
    });

    it("ignores a reply to the bot's \"hello there\" easter egg", () => {
        const facts = readTriggerFacts(messageWith('lmao'), BOT_ID, { message: GENERAL_KENOBI, answered: HELLO_THERE }, false);
        expect(resolveTrigger(facts)).toEqual({ kind: 'none' });
    });

    it('ignores a reply to someone else that does not name the bot', () => {
        const facts = readTriggerFacts(messageWith('lol'), BOT_ID, { message: messageWith('hi'), answered: null }, false);
        expect(resolveTrigger(facts)).toEqual({ kind: 'none' });
    });

    it('answers a reply to someone else that names the bot', () => {
        const facts = readTriggerFacts(messageWith(`<@${BOT_ID}> settle this`), BOT_ID, { message: messageWith('hi'), answered: null }, false);
        expect(resolveTrigger(facts)).toEqual({ kind: 'mention' });
    });

    it('does not count a role mention with the same id as a mention of the bot', () => {
        expect(readTriggerFacts(messageWith(`<@&${BOT_ID}>`), BOT_ID, null, false).mentionsBot).toBe(false);
    });
});
