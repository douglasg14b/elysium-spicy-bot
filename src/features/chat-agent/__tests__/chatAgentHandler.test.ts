import { MockLanguageModelV4 } from 'ai/test';
import { ChannelType, Collection, MessageType } from 'discord.js';
import type { ClientUser, Message } from 'discord.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TicketEntity } from '../../tickets';
import { createPerGuildQueue } from '../../../shared/perGuildQueue';
import { handleChatMessage, type ChatAgentDependencies } from '../chatAgentHandler';
import { ChatRateLimiter } from '../safety/rateLimit';
import { ChatSessionStore } from '../session/chatSessionStore';

const tickets = vi.hoisted(() => ({ current: null as TicketEntity | null }));
vi.mock('../../tickets', () => ({ getTicketByChannel: async () => tickets.current }));
vi.mock('../../../features-system/guild-settings', () => ({
    guildSettingsRepo: {
        getTimeZone: async () => ({ chosen: null, effective: 'America/Los_Angeles' }),
        getStaffRoleIds: async () => [],
    },
    DEFAULT_GUILD_TIME_ZONE: 'America/Los_Angeles',
}));
const NOTHING_CONFIGURED = { contextChannels: [], serverNotes: '', botRules: '' };
const savedConfig = vi.hoisted(() => ({ current: null as { serverNotes: string; botRules: string } | null }));
vi.mock('../data/chatAgentConfigRepo', () => ({
    chatAgentConfigRepo: { getConfig: async () => ({ ...NOTHING_CONFIGURED, ...savedConfig.current }) },
}));

const AN_OPEN_TICKET = { id: 1, ticketNumber: 42, status: 'open' } as unknown as TicketEntity;

beforeEach(() => {
    tickets.current = null;
    savedConfig.current = null;
});

const BOT_ID = '900000000000000001';
const BOT_USER = { id: BOT_ID, displayName: 'BrattyBot' } as unknown as ClientUser;

const USAGE = {
    inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: 5, text: 5, reasoning: undefined },
};

function modelStayingQuiet() {
    return new MockLanguageModelV4({
        doGenerate: async () => ({
            content: [{ type: 'tool-call', toolCallId: 'call-1', toolName: 'stayQuiet', input: '{"reason":"flirting"}' }],
            finishReason: { unified: 'tool-calls', raw: undefined },
            usage: USAGE,
            warnings: [],
        }),
    });
}

function modelSaying(text: string, gate?: Promise<void>) {
    return new MockLanguageModelV4({
        doGenerate: async () => {
            await gate;
            return {
                content: [{ type: 'text', text }],
                finishReason: { unified: 'stop', raw: undefined },
                usage: USAGE,
                warnings: [],
            };
        },
    });
}

type FakeServer = { sent: unknown[]; replies: unknown[] };

type FakeServerApi = {
    /** A member's message that @s the bot. */
    mentionFrom: (userId: string, text: string) => Message;
    /** A member's message replying to `repliedTo` (a bot post), without naming the bot. */
    replyFrom: (userId: string, text: string, repliedTo: Message) => Message;
    /** A message the bot posted: a chat agent reply, or a plain automated post. */
    botPost: (kind: 'chatAgent' | 'automated') => Message;
};

/** One channel, one bot. */
function fakeServer(): FakeServer & FakeServerApi {
    const server: FakeServer = { sent: [], replies: [] };
    let nextId = 1;
    const allowEverything = { has: () => true };
    const me = { id: BOT_ID, displayName: 'BrattyBot' };
    const guild = { id: 'guild', name: 'Elysium', ownerId: 'owner', memberCount: 0, members: { me, fetch: vi.fn(), cache: new Map() }, channels: { cache: new Map() }, roles: { cache: new Map() } };
    const channel = {
        id: 'channel',
        name: 'general',
        type: ChannelType.GuildText,
        position: 0,
        parent: null,
        nsfw: false,
        guild,
        isThread: () => false,
        permissionsFor: () => allowEverything,
        sendTyping: async () => undefined,
        send: async (options: unknown) => {
            server.sent.push(options);
            return { id: `posted-${nextId++}` };
        },
        messages: { fetch: async () => new Collection<string, Message>() },
    };
    guild.channels.cache.set(channel.id, channel);

    const messageFrom = (userId: string, content: string, repliedTo: Message | null): Message => {
        // Nobody here is staff: the staff-only tools stay shut and turns keep the short limits.
        const member = { id: userId, displayName: userId, guild, permissions: { has: () => false }, roles: { cache: new Map() } };
        const message = {
            id: `incoming-${nextId++}`,
            content,
            system: false,
            type: repliedTo ? MessageType.Reply : MessageType.Default,
            author: { id: userId, bot: false, displayName: userId },
            member,
            guild,
            guildId: 'guild',
            channel,
            channelId: 'channel',
            createdAt: new Date('2026-11-06T21:04:00Z'),
            reference: repliedTo ? { messageId: repliedTo.id } : null,
            fetchReference: async () => repliedTo,
            attachments: new Collection(),
            embeds: [],
            mentions: {
                users: new Collection(),
                members: new Collection(),
                roles: new Collection(),
                repliedUser: repliedTo ? { id: repliedTo.author.id } : null,
            },
            inGuild: () => true,
            reply: async (options: unknown) => {
                server.replies.push(options);
                return { id: `posted-${nextId++}` };
            },
        };
        channel.messages.fetch = async () => new Collection([[message.id, message as unknown as Message]]);
        return message as unknown as Message;
    };

    const mentionFrom = (userId: string, text: string) => messageFrom(userId, `<@${BOT_ID}> ${text}`, null);
    const replyFrom = (userId: string, text: string, repliedTo: Message) => messageFrom(userId, text, repliedTo);
    const botPost = (kind: 'chatAgent' | 'automated'): Message => {
        // A chat agent post answers a message that @'d the bot; an automated one answers nothing.
        const answered = kind === 'chatAgent' ? mentionFrom('someone', 'question') : null;
        return {
            id: `bot-post-${nextId++}`,
            author: { id: BOT_ID, bot: true },
            type: kind === 'chatAgent' ? MessageType.Reply : MessageType.Default,
            reference: answered ? { messageId: answered.id } : null,
            fetchReference: async () => answered,
        } as unknown as Message;
    };

    return Object.assign(server, { mentionFrom, replyFrom, botPost });
}

function dependencies(model: MockLanguageModelV4): ChatAgentDependencies {
    return {
        sessions: new ChatSessionStore(),
        channelQueue: createPerGuildQueue(),
        pendingTurns: new Map(),
        rateLimiter: new ChatRateLimiter(),
        model,
    };
}

describe('handleChatMessage', () => {
    it('replies without letting the model ping anyone, posts made-up markup as text, and remembers the turn under its asker', async () => {
        const server = fakeServer();
        const deps = dependencies(modelSaying('@everyone look, <@&123> too. Hi.'));

        await handleChatMessage(server.mentionFrom('vex', 'hi'), BOT_USER, deps);

        expect(server.replies).toEqual([
            {
                content: '@everyone look, @someone too. Hi.',
                allowedMentions: { parse: [], repliedUser: true },
                failIfNotExists: false,
            },
        ]);
        // incoming-1 was the mention; its reply posted as posted-2.
        expect(deps.sessions.traceLookup('channel')('posted-2')).toMatchObject({ askerId: 'vex' });
    });

    it("remembers a staff-only tool's answer only as a note, so a follow-up has to ask it again", async () => {
        const server = fakeServer();
        let call = 0;
        const model = new MockLanguageModelV4({
            doGenerate: async () => {
                call += 1;
                return call === 1
                    ? {
                          content: [{ type: 'tool-call', toolCallId: 'call-1', toolName: 'findTickets', input: '{"query":"57"}' }],
                          finishReason: { unified: 'tool-calls', raw: undefined },
                          usage: USAGE,
                          warnings: [],
                      }
                    : { content: [{ type: 'text', text: 'Not yours to read.' }], finishReason: { unified: 'stop', raw: undefined }, usage: USAGE, warnings: [] };
            },
        });
        const deps = dependencies(model);

        await handleChatMessage(server.mentionFrom('vex', 'what was ticket 57?'), BOT_USER, deps);

        const trace = deps.sessions.traceLookup('channel')('posted-2');
        expect(JSON.stringify(trace)).toContain('Not kept between turns');
        // What the tool answered this turn (Vex isn't staff) is not what the session keeps.
        expect(JSON.stringify(trace)).not.toContain('pay grade');
    });

    it('turns the #channel the model names into a link before posting', async () => {
        const server = fakeServer();

        await handleChatMessage(server.mentionFrom('vex', 'where do I chat?'), BOT_USER, dependencies(modelSaying('Right here, #general.')));

        expect(server.replies).toEqual([expect.objectContaining({ content: 'Right here, <#channel>.' })]);
    });

    it("reads the server's saved rules and notes into the turn's instructions", async () => {
        savedConfig.current = { botRules: 'Never name other servers.', serverNotes: 'Munches are the first Saturday.' };
        const server = fakeServer();
        const model = modelSaying('First Saturday, keep up.');

        await handleChatMessage(server.mentionFrom('vex', "when's the munch?"), BOT_USER, dependencies(model));

        const system = JSON.stringify(model.doGenerateCalls[0]?.prompt[0]);
        expect(system).toContain('Never name other servers.');
        expect(system).toContain('Munches are the first Saturday.');
    });

    it('posts the fallback line once when the turn fails', async () => {
        const server = fakeServer();
        const failing = new MockLanguageModelV4({
            doGenerate: async () => {
                throw new Error('provider fell over');
            },
        });
        const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);

        await handleChatMessage(server.mentionFrom('vex', 'hi'), BOT_USER, dependencies(failing));

        expect(server.replies).toHaveLength(1);
        expect(server.replies[0]).toMatchObject({ allowedMentions: { parse: [], repliedUser: true } });
        expect(errors.mock.calls.flat().join(' ')).toContain('provider fell over');
        errors.mockRestore();
    });

    it('drops turns past three waiting in one channel', async () => {
        const server = fakeServer();
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const deps = dependencies(modelSaying('ok', gate));
        const warnings = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

        const turns = ['a', 'b', 'c', 'd', 'e'].map((member) => handleChatMessage(server.mentionFrom(member, 'hi'), BOT_USER, deps));
        await new Promise((resolve) => setTimeout(resolve, 10));
        release();
        await Promise.all(turns);

        expect(server.replies).toHaveLength(3);
        expect(warnings.mock.calls.filter(([line]) => String(line).includes('dropped one'))).toHaveLength(2);
        warnings.mockRestore();
    });

    it('ignores a message that is not for the bot', async () => {
        const server = fakeServer();
        const message = server.mentionFrom('vex', 'hi');
        Object.assign(message, { content: 'just chatting' });

        await handleChatMessage(message, BOT_USER, dependencies(modelSaying('should not run')));

        expect(server.replies).toHaveLength(0);
    });

    it('answers a reply to something the chat agent said', async () => {
        const server = fakeServer();
        await handleChatMessage(server.replyFrom('vex', 'and?', server.botPost('chatAgent')), BOT_USER, dependencies(modelSaying('And nothing.')));
        expect(server.replies).toHaveLength(1);
    });

    it("never answers a reply to the bot's automated posts, like an onboarding question or ticket controls", async () => {
        const server = fakeServer();
        await handleChatMessage(server.replyFrom('vex', 'they/them', server.botPost('automated')), BOT_USER, dependencies(modelSaying('should not run')));
        expect(server.replies).toHaveLength(0);
    });

    describe('in a ticket', () => {
        beforeEach(() => {
            tickets.current = AN_OPEN_TICKET;
        });

        it('never answers a reply, even to the chat agent', async () => {
            const server = fakeServer();
            await handleChatMessage(server.replyFrom('vex', 'and?', server.botPost('chatAgent')), BOT_USER, dependencies(modelSaying('should not run')));
            expect(server.replies).toHaveLength(0);
        });

        it('answers an explicit mention the agent judges a real question', async () => {
            const server = fakeServer();
            await handleChatMessage(server.mentionFrom('vex', 'can I DM people once verified?'), BOT_USER, dependencies(modelSaying('Ask first. Rule three.')));
            expect(server.replies).toEqual([expect.objectContaining({ content: 'Ask first. Rule three.' })]);
        });

        it('posts nothing, and remembers nothing, when the agent stays quiet', async () => {
            const server = fakeServer();
            const deps = dependencies(modelStayingQuiet());
            await handleChatMessage(server.mentionFrom('vex', 'step on me while I wait'), BOT_USER, deps);
            expect(server.replies).toHaveLength(0);
            expect(server.sent).toHaveLength(0);
        });

        it('takes a silence typed out instead of stayQuiet as silence, without asking again', async () => {
            const server = fakeServer();
            const model = modelSaying('Stay quiet. Reason: banter.');
            await handleChatMessage(server.mentionFrom('vex', 'step on me'), BOT_USER, dependencies(model));
            expect(server.replies).toHaveLength(0);
            expect(server.sent).toHaveLength(0);
            expect(model.doGenerateCalls).toHaveLength(1);
        });
    });

    it('asks once more when the reply calls someone a pet name, and posts the second', async () => {
        const server = fakeServer();
        const model = new MockLanguageModelV4({
            doGenerate: ['Oh, darling, no.', 'No.'].map((text) => ({
                content: [{ type: 'text' as const, text }],
                finishReason: { unified: 'stop' as const, raw: undefined },
                usage: USAGE,
                warnings: [],
            })),
        });

        await handleChatMessage(server.mentionFrom('vex', 'write me smut'), BOT_USER, dependencies(model));

        expect(server.replies).toEqual([expect.objectContaining({ content: 'No.' })]);
    });
});
