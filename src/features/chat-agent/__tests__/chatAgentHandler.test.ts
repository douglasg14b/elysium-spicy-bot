import { MockLanguageModelV4 } from 'ai/test';
import { ChannelType, Collection, MessageType } from 'discord.js';
import type { ClientUser, Message } from 'discord.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TicketEntity } from '../../tickets';
import { createPerGuildQueue } from '../../../shared/perGuildQueue';
import { handleChatMessage, type ChatAgentDependencies } from '../chatAgentHandler';
import { ChatRateLimiter } from '../safety/rateLimit';
import type { DatabaseClient } from '../../../features-system/data-persistence/database';
import { ChatSessionsRepo } from '../data/chatSessionsRepo';
import { chatSessionsTestDb } from '../data/__tests__/support/chatSessionsTestDb';
import { ChatSessions } from '../session/chatSessions';

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

let sessionsDb: DatabaseClient;

beforeEach(async () => {
    tickets.current = null;
    savedConfig.current = null;
    sessionsDb = await chatSessionsTestDb();
});

const sessionsRepo = () => new ChatSessionsRepo(sessionsDb);

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

type FakeServer = { sent: unknown[]; replies: unknown[]; chatterSinceAnyPost: number };

/** The `n`th message the fake channel makes, as a snowflake: ids order as Discord's do. */
const snowflake = (n: number) => String(1_000_000 + n * 1_000);

/** Vex's answer in each test: the mention is the first message, its reply the second. */
const FIRST_REPLY = snowflake(2);

type FakeServerApi = {
    /** A member's message that @s the bot. */
    mentionFrom: (userId: string, text: string) => Message;
    /** A member's message replying to `repliedTo` (a bot post), without naming the bot. */
    replyFrom: (userId: string, text: string, repliedTo: Message) => Message;
    /** A message the bot posted: a chat agent reply, or a plain automated post. */
    botPost: (kind: 'chatAgent' | 'automated', id?: string) => Message;
};

/** One channel, one bot. */
function fakeServer(): FakeServer & FakeServerApi {
    const server: FakeServer = { sent: [], replies: [], chatterSinceAnyPost: 0 };
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
            return { id: snowflake(nextId++) };
        },
        messages: { fetch: async () => new Collection<string, Message>() },
    };
    guild.channels.cache.set(channel.id, channel);

    const messageFrom = (userId: string, content: string, repliedTo: Message | null): Message => {
        // Nobody here is staff: the staff-only tools stay shut and turns keep the short limits.
        const member = { id: userId, displayName: userId, guild, user: { bot: false }, permissions: { has: () => false }, roles: { cache: new Map() } };
        // Everyone who has spoken can read the channel.
        guild.members.cache.set(userId, member);
        const message = {
            id: snowflake(nextId++),
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
                return { id: snowflake(nextId++) };
            },
        };
        // The channel's newest message is the latest one made; a read after any post finds the chatter since.
        channel.messages.fetch = async (options?: { after?: string }) =>
            options?.after
                ? new Collection(Array.from({ length: server.chatterSinceAnyPost }, (_unused, index) => [String(1_000_000 + index), { id: String(1_000_000 + index), author: { id: 'someone' } } as unknown as Message]))
                : new Collection([[message.id, message as unknown as Message]]);
        return message as unknown as Message;
    };

    const mentionFrom = (userId: string, text: string) => messageFrom(userId, `<@${BOT_ID}> ${text}`, null);
    const replyFrom = (userId: string, text: string, repliedTo: Message) => messageFrom(userId, text, repliedTo);
    const botPost = (kind: 'chatAgent' | 'automated', id?: string): Message => {
        // A chat agent post answers a message that @'d the bot; an automated one answers nothing.
        const answered = kind === 'chatAgent' ? mentionFrom('someone', 'question') : null;
        return {
            id: id ?? snowflake(nextId++),
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
        sessions: new ChatSessions(sessionsRepo()),
        channelQueue: createPerGuildQueue(),
        pendingTurns: new Map(),
        rateLimiter: new ChatRateLimiter(),
        model,
    };
}

describe('handleChatMessage', () => {
    it('replies without letting the model ping anyone, posts made-up markup as text, and starts a session with the turn', async () => {
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
        const session = await sessionsRepo().findByPost('guild', FIRST_REPLY);
        expect(session).toMatchObject({ channelId: 'channel', lastPostId: FIRST_REPLY });
        expect(await sessionsRepo().listTurns(session?.id ?? '')).toEqual([
            expect.objectContaining({
                askerId: 'vex',
                questionId: snowflake(1),
                question: '[2026-11-06 21:04] vex: @someone hi',
                answer: '@everyone look, @someone too. Hi.',
                model: 'mock-model-id',
                readerIds: ['vex'],
                visibleChannelIds: ['channel'],
                messages: [{ role: 'assistant', content: [{ type: 'text', text: '@everyone look, @someone too. Hi.' }] }],
                postIds: [FIRST_REPLY],
            }),
        ]);
    });

    it("hands the next turn in the channel what this one looked up, whoever asks it", async () => {
        const server = fakeServer();
        // Mara has spoken here, so she reads Vex's answer too.
        server.mentionFrom('mara', 'hey');
        let call = 0;
        const model = new MockLanguageModelV4({
            doGenerate: async () => {
                call += 1;
                return call === 1
                    ? {
                          content: [{ type: 'tool-call', toolCallId: 'call-1', toolName: 'getTicketInfo', input: '{}' }],
                          finishReason: { unified: 'tool-calls', raw: undefined },
                          usage: USAGE,
                          warnings: [],
                      }
                    : { content: [{ type: 'text', text: 'Not a ticket.' }], finishReason: { unified: 'stop', raw: undefined }, usage: USAGE, warnings: [] };
            },
        });
        const deps = dependencies(model);

        await handleChatMessage(server.mentionFrom('vex', 'is this a ticket?'), BOT_USER, deps);
        await handleChatMessage(server.mentionFrom('mara', 'wait, is it?'), BOT_USER, deps);

        // Vex's reply has left the window the fake channel holds, so the session puts it first.
        const followUp = JSON.stringify(model.doGenerateCalls.at(-1)?.prompt);
        expect(followUp).toContain('vex: @someone is this a ticket?');
        expect(followUp).toContain('"toolName":"getTicketInfo","output":{"type":"json","value":{"isTicket":false}}');
        expect(followUp).toContain('Not a ticket.');
        expect(followUp).toContain('mara: @someone wait, is it?');
    });

    it("starts afresh once the channel has moved on, but a reply to the old session's post carries it on", async () => {
        const server = fakeServer();
        const model = modelSaying('Rule three.');
        const deps = dependencies(model);
        await handleChatMessage(server.mentionFrom('vex', 'can I DM people?'), BOT_USER, deps);
        // Then the channel talks among itself.
        server.chatterSinceAnyPost = 60;

        await handleChatMessage(server.mentionFrom('mara', 'what did you tell vex?'), BOT_USER, deps);
        expect(JSON.stringify(model.doGenerateCalls.at(-1)?.prompt)).not.toContain('can I DM people?');

        await handleChatMessage(server.replyFrom('mara', 'what did you tell vex?', server.botPost('chatAgent', FIRST_REPLY)), BOT_USER, deps);
        expect(JSON.stringify(model.doGenerateCalls.at(-1)?.prompt)).toContain('vex: @someone can I DM people?');
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
