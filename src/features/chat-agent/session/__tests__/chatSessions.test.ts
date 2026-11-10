import type { ModelMessage } from 'ai';
import { ChannelType, Collection, type Message } from 'discord.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatSessionsRepo, type NewSessionTurn } from '../../data/chatSessionsRepo';
import { chatSessionsTestDb } from '../../data/__tests__/support/chatSessionsTestDb';
import type { ChatToolContext } from '../../tools/chatToolContext';
import { ChatSessions, MAX_TURNS_PER_SESSION, SESSION_ACTIVITY_LIMIT, SESSION_IDLE_MS, SESSION_REVIVAL_MS, sessionTurnFrom } from '../chatSessions';
import type { HistoryMessage } from '../historyToModelMessages';

const BOT_ID = 'bot';
const GUILD = 'guild-1';
const CHANNEL = 'channel-1';
const NOON = new Date('2026-11-09T12:00:00.000Z');
const MINUTE = 60_000;

let repo: ChatSessionsRepo;
let sessions: ChatSessions;

beforeEach(async () => {
    repo = new ChatSessionsRepo(await chatSessionsTestDb());
    sessions = new ChatSessions(repo);
});

const TURN: Omit<NewSessionTurn, 'postIds'> = {
    askerId: 'vex',
    questionId: 'question',
    question: 'q',
    answer: 'a',
    messages: [{ role: 'assistant', content: 'a' }],
    model: 'model',
    readerIds: ['vex'],
    visibleChannelIds: [],
};

async function recordAt(sessionId: string | null, postId: string, at: Date, channelId = CHANNEL): Promise<string> {
    await sessions.record({ sessionId, guildId: GUILD, channelId, turn: { ...TURN, postIds: [postId] }, now: at });
    const session = await repo.findByPost(GUILD, postId);
    if (!session) throw new Error('not recorded');
    return session.id;
}

/** A message in the channel, which `othersSince` other messages from people (and a few from the bot) have followed since any post. */
function trigger(othersSince = 0, channelId = CHANNEL) {
    const fetch = vi.fn(async () => {
        const people = Array.from({ length: othersSince }, (_unused, index) => [`${1000 + index}`, { id: `${1000 + index}`, author: { id: `person-${index}` } }] as const);
        const bot = Array.from({ length: 3 }, (_unused, index) => [`${5000 + index}`, { id: `${5000 + index}`, author: { id: BOT_ID } }] as const);
        // What came in while the turn waited in the queue: after the trigger, so not counted.
        const later = Array.from({ length: SESSION_ACTIVITY_LIMIT }, (_unused, index) => [`${20000 + index}`, { id: `${20000 + index}`, author: { id: 'latecomer' } }] as const);
        return new Collection<string, unknown>([...people, ...bot, ['9999', { id: '9999', author: { id: 'vex' } }], ...later]);
    });
    const message = { id: '9999', guildId: GUILD, channelId, channel: { messages: { fetch } } } as unknown as Message<true>;
    return { message, fetch };
}

describe('ChatSessions.resolve', () => {
    it('starts a session when the channel has none', async () => {
        expect(await sessions.resolve(trigger().message, BOT_ID, null, NOON)).toEqual({ id: null, turns: [] });
    });

    it('carries the live session on for anyone, with its turns, counting what was said since its last post', async () => {
        const id = await recordAt(null, 'post-1', NOON);
        const { message, fetch } = trigger(SESSION_ACTIVITY_LIMIT - 1);

        const resolved = await sessions.resolve(message, BOT_ID, null, new Date(NOON.getTime() + SESSION_IDLE_MS - MINUTE));

        expect(resolved).toMatchObject({ id, turns: [{ postIds: ['post-1'] }] });
        expect(fetch).toHaveBeenCalledWith({ after: 'post-1', limit: 100 });
    });

    it(`ends it after ${SESSION_ACTIVITY_LIMIT} other messages before the trigger — the bot's own, the trigger and what came after not counted`, async () => {
        await recordAt(null, 'post-1', NOON);
        expect(await sessions.resolve(trigger(SESSION_ACTIVITY_LIMIT).message, BOT_ID, null, NOON)).toEqual({ id: null, turns: [] });
    });

    it('ends it after an hour with no turn, without asking Discord', async () => {
        await recordAt(null, 'post-1', NOON);
        const { message, fetch } = trigger();
        expect(await sessions.resolve(message, BOT_ID, null, new Date(NOON.getTime() + SESSION_IDLE_MS))).toEqual({ id: null, turns: [] });
        expect(fetch).not.toHaveBeenCalled();
    });

    it('never carries on another channel’s session', async () => {
        await recordAt(null, 'post-1', NOON, 'channel-2');
        expect(await sessions.resolve(trigger().message, BOT_ID, null, NOON)).toEqual({ id: null, turns: [] });
    });

    it('revives an ended session for a reply to one of its posts, up to a day after its last turn', async () => {
        const old = await recordAt(null, 'post-1', NOON);
        // A newer session has taken over the channel since.
        await recordAt(null, 'post-2', new Date(NOON.getTime() + 2 * SESSION_IDLE_MS));
        const { message } = trigger(SESSION_ACTIVITY_LIMIT * 3);

        expect((await sessions.resolve(message, BOT_ID, 'post-1', new Date(NOON.getTime() + SESSION_REVIVAL_MS - MINUTE))).id).toBe(old);
    });

    it('does not revive one past its day: the reply goes the way a mention would', async () => {
        await recordAt(null, 'post-1', NOON);
        expect(await sessions.resolve(trigger().message, BOT_ID, 'post-1', new Date(NOON.getTime() + SESSION_REVIVAL_MS))).toEqual({ id: null, turns: [] });
    });

    it("does not revive one from another channel, a post that's moved with its thread", async () => {
        await recordAt(null, 'post-1', NOON, 'channel-2');
        expect(await sessions.resolve(trigger().message, BOT_ID, 'post-1', NOON)).toEqual({ id: null, turns: [] });
    });
});

describe('ChatSessions.record', () => {
    it('sweeps away every session past its day as it records', async () => {
        await recordAt(null, 'post-1', NOON, 'channel-2');
        await recordAt(null, 'post-2', new Date(NOON.getTime() + SESSION_REVIVAL_MS + MINUTE));
        expect(await repo.findByPost(GUILD, 'post-1')).toBeUndefined();
    });

    it(`keeps a session's newest ${MAX_TURNS_PER_SESSION} turns`, async () => {
        const id = await recordAt(null, 'post-0', NOON);
        for (let index = 1; index <= MAX_TURNS_PER_SESSION; index += 1) await recordAt(id, `post-${index}`, NOON);
        const turns = await repo.listTurns(id);
        expect(turns).toHaveLength(MAX_TURNS_PER_SESSION);
        expect(turns[0]?.postIds).toEqual(['post-1']);
    });
});

describe('ChatSessions.record and sweep', () => {
    it("keeps a recorded turn when the sweep after it fails, logging the sweep's failure as its own", async () => {
        const failing = Object.assign(Object.create(repo) as ChatSessionsRepo, { deleteInactiveSince: async () => Promise.reject(new Error('disk full')) });
        const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);

        await new ChatSessions(failing).record({ sessionId: null, guildId: GUILD, channelId: CHANNEL, turn: { ...TURN, postIds: ['post-1'] }, now: NOON });

        expect(await repo.findByPost(GUILD, 'post-1')).toBeDefined();
        expect(logged).toHaveBeenCalledWith('[chat-agent] could not sweep ended sessions:', expect.any(Error));
    });

    it('sweeps on its own too, for a server nobody talks to the bot in any more', async () => {
        await recordAt(null, 'post-1', NOON);
        await sessions.sweep(new Date(NOON.getTime() + SESSION_REVIVAL_MS + MINUTE));
        expect(await repo.findByPost(GUILD, 'post-1')).toBeUndefined();
    });
});

describe('sessionTurnFrom', () => {
    const answered: HistoryMessage = {
        id: 'q',
        authorName: 'Vex',
        isFromThisBot: false,
        isFromOtherBot: false,
        content: 'can I DM people?',
        createdAt: new Date('2026-11-09T12:00:00Z'),
        replyToAuthorName: undefined,
        isBeingAnswered: true,
    };
    const context = { asker: { id: 'vex' }, viewers: [{ id: 'vex', guild: { channels: { cache: new Map([['1', { id: '1', name: 'rules', type: ChannelType.GuildText, isThread: () => false, parent: null, position: 0, permissionsFor: () => ({ has: () => true }) }]]) } } }, { id: 'kat' }] } as unknown as Pick<ChatToolContext, 'asker' | 'viewers'>;

    it('keeps the question as the model read it, the parts that posted, and who could read them', () => {
        expect(sessionTurnFrom({ history: [answered], context, modelId: 'model', messages: [], posted: { parts: ['Ask first.', 'Rule three.'], ids: ['p1'] } })).toEqual({
            askerId: 'vex',
            questionId: 'q',
            question: '[2026-11-09 12:00] Vex: can I DM people?',
            // Only the first part posted.
            answer: 'Ask first.',
            messages: [{ role: 'assistant', content: [{ type: 'text', text: 'Ask first.' }] }],
            model: 'model',
            readerIds: ['vex', 'kat'],
            visibleChannelIds: ['1'],
            postIds: ['p1'],
        });
    });

    it("makes the trace's last word the reply as posted, its links names again — not the model's draft", () => {
        const draft: ModelMessage[] = [
            { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'c', toolName: 'getServerRules', input: {} }] },
            { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'c', toolName: 'getServerRules', output: { type: 'json', value: {} } }] },
            { role: 'assistant', content: [{ type: 'text', text: 'Ask first, darling 😘😘😘' }] },
        ];
        const stored = sessionTurnFrom({ history: [answered], context, modelId: 'model', messages: draft, posted: { parts: ['Ask first, <#1>.'], ids: ['p1'] } });

        expect(stored.answer).toBe('Ask first, #rules.');
        expect(stored.messages).toEqual([...draft.slice(0, 2), { role: 'assistant', content: [{ type: 'text', text: 'Ask first, #rules.' }] }]);
    });

    it('refuses a history with no message marked as answered', () => {
        expect(() => sessionTurnFrom({ history: [{ ...answered, isBeingAnswered: false }], context, modelId: 'model', messages: [], posted: { parts: ['a'], ids: ['p1'] } })).toThrow(
            'no message marked as answered'
        );
    });
});
