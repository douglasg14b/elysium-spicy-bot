import type { ModelMessage } from 'ai';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseClient } from '../../../../features-system/data-persistence/database';
import { ChatSessionsRepo, type NewSessionTurn } from '../chatSessionsRepo';
import { chatSessionsTestDb } from './support/chatSessionsTestDb';

/** The session repo against real SQL, on the migration's own sqlite arm. */

let db: DatabaseClient;
let repo: ChatSessionsRepo;

const GUILD = 'guild-1';
const CHANNEL = 'channel-1';
const NOON = new Date('2026-11-09T12:00:00.000Z');

const LOOKED_UP: readonly ModelMessage[] = [
    { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'call-1', toolName: 'getServerRules', input: {} }] },
    { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'call-1', toolName: 'getServerRules', output: { type: 'json', value: { found: true, rules: 'Ask first.' } } }] },
    { role: 'assistant', content: 'Ask first.' },
];

function turn(postIds: string[], overrides: Partial<NewSessionTurn> = {}): NewSessionTurn {
    return {
        askerId: 'vex',
        questionId: `question-for-${postIds[0] ?? 'nothing'}`,
        question: '[2026-11-09 12:00] Vex: can I DM?',
        answer: 'Ask first.',
        messages: LOOKED_UP,
        model: 'mistralai/mistral-large-4-0',
        readerIds: ['vex', 'kat'],
        visibleChannelIds: ['general'],
        postIds,
        ...overrides,
    };
}

async function record(sessionId: string | null, postIds: string[], now = NOON, keepTurns = 20): Promise<string> {
    return repo.recordTurn({ sessionId, guildId: GUILD, channelId: CHANNEL, turn: turn(postIds), now, keepTurns });
}

beforeEach(async () => {
    db = await chatSessionsTestDb();
    repo = new ChatSessionsRepo(db);
});

describe('ChatSessionsRepo', () => {
    it('starts a session with its first turn, and reads the turn back whole — model messages, readers, posts', async () => {
        const sessionId = await record(null, ['post-1', 'post-2']);

        expect(await repo.findLatestInChannel(GUILD, CHANNEL)).toEqual({
            id: sessionId,
            guildId: GUILD,
            channelId: CHANNEL,
            startedAt: NOON,
            lastActiveAt: NOON,
            lastPostId: 'post-2',
        });
        expect(await repo.listTurns(sessionId)).toEqual([{ ...turn(['post-1', 'post-2']), createdAt: NOON }]);
    });

    it("finds a session by any of its posts, only in the post's own guild", async () => {
        const sessionId = await record(null, ['post-1', 'post-2']);

        expect((await repo.findByPost(GUILD, 'post-2'))?.id).toBe(sessionId);
        expect(await repo.findByPost('guild-2', 'post-2')).toBeUndefined();
        expect(await repo.findByPost(GUILD, 'someone-elses-message')).toBeUndefined();
    });

    it('carries a session on: its activity and last post move to the new turn, which joins the end', async () => {
        const sessionId = await record(null, ['post-1']);
        const later = new Date(NOON.getTime() + 60_000);
        expect(await record(sessionId, ['post-2'], later)).toBe(sessionId);

        expect(await repo.findLatestInChannel(GUILD, CHANNEL)).toMatchObject({ startedAt: NOON, lastActiveAt: later, lastPostId: 'post-2' });
        expect((await repo.listTurns(sessionId)).map((stored) => stored.postIds)).toEqual([['post-1'], ['post-2']]);
    });

    it('keeps only the newest turns, while a reply to a dropped one still finds the session', async () => {
        const sessionId = await record(null, ['post-1'], NOON, 2);
        await record(sessionId, ['post-2'], NOON, 2);
        await record(sessionId, ['post-3'], NOON, 2);

        expect((await repo.listTurns(sessionId)).map((stored) => stored.postIds)).toEqual([['post-2'], ['post-3']]);
        expect((await repo.findByPost(GUILD, 'post-1'))?.id).toBe(sessionId);
    });

    it('finds the most recently active of a channel’s sessions', async () => {
        await record(null, ['post-1'], NOON);
        const newer = await record(null, ['post-2'], new Date(NOON.getTime() + 1_000));
        expect((await repo.findLatestInChannel(GUILD, CHANNEL))?.id).toBe(newer);
        expect(await repo.findLatestInChannel(GUILD, 'channel-2')).toBeUndefined();
    });

    it('sweeps sessions last active before the cutoff, with their turns and posts, and nothing newer', async () => {
        const old = await record(null, ['post-1'], NOON);
        const fresh = await record(null, ['post-2'], new Date(NOON.getTime() + 10_000));

        await repo.deleteInactiveSince(new Date(NOON.getTime() + 5_000));

        expect(await repo.findByPost(GUILD, 'post-1')).toBeUndefined();
        expect(await repo.listTurns(old)).toEqual([]);
        expect((await repo.findByPost(GUILD, 'post-2'))?.id).toBe(fresh);
        expect(await repo.listTurns(fresh)).toHaveLength(1);
    });

    it('reads a turn whose stored messages no longer parse as having none, keeping its text', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const sessionId = await record(null, ['post-1']);
        await db.updateTable('chat_agent_session_turns').set({ messages: JSON.stringify([{ role: 'wizard', spell: 'fireball' }]) }).execute();

        expect(await repo.listTurns(sessionId)).toEqual([expect.objectContaining({ messages: undefined, answer: 'Ask first.' })]);
    });

    it('reads a turn whose readers no longer parse as ids as having no trace: they decide who may see it', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const sessionId = await record(null, ['post-1']);
        await db.updateTable('chat_agent_session_turns').set({ readerIds: JSON.stringify('vex,kat') }).execute();

        expect(await repo.listTurns(sessionId)).toEqual([expect.objectContaining({ messages: undefined, readerIds: [], postIds: ['post-1'] })]);
    });

    it('writes a session swept while its turn ran back under the same id, so the turn is never left under none', async () => {
        const sessionId = await record(null, ['post-1'], NOON);
        await repo.deleteInactiveSince(new Date(NOON.getTime() + 1_000));
        const later = new Date(NOON.getTime() + 2_000);

        expect(await record(sessionId, ['post-2'], later)).toBe(sessionId);
        expect(await repo.findByPost(GUILD, 'post-2')).toMatchObject({ id: sessionId, startedAt: later, lastActiveAt: later });
        expect((await repo.listTurns(sessionId)).map((stored) => stored.postIds)).toEqual([['post-2']]);
    });

    it('sweeps away turns and posts left under no session', async () => {
        const sessionId = await record(null, ['post-1'], NOON);
        await db.deleteFrom('chat_agent_sessions').execute();

        await repo.deleteInactiveSince(NOON);

        expect(await db.selectFrom('chat_agent_session_turns').select('id').execute()).toEqual([]);
        expect(await db.selectFrom('chat_agent_session_posts').select('messageId').execute()).toEqual([]);
        expect(await repo.listTurns(sessionId)).toEqual([]);
    });

    it('deletes the turn whose post or question was deleted, in that guild only, keeping the rest of the session', async () => {
        const sessionId = await record(null, ['post-1', 'post-1b']);
        await record(sessionId, ['post-2']);
        await record(sessionId, ['post-3']);

        await repo.deleteTurnsTouching('guild-2', ['post-1', 'question-for-post-2']);
        expect(await repo.listTurns(sessionId)).toHaveLength(3);

        await repo.deleteTurnsTouching(GUILD, ['post-1b', 'question-for-post-2']);
        expect((await repo.listTurns(sessionId)).map((stored) => stored.postIds)).toEqual([['post-3']]);
        // A reply to a deleted turn's other part still finds the session.
        expect((await repo.findByPost(GUILD, 'post-1'))?.id).toBe(sessionId);
    });

    it('stores what Postgres would refuse as text it takes: half an emoji, a NUL', async () => {
        const halfAnEmoji = `so Damon ${String.fromCharCode(0xd83d)}`;
        const sessionId = await repo.recordTurn({
            sessionId: null,
            guildId: GUILD,
            channelId: CHANNEL,
            turn: turn(['post-1'], {
                question: `nul${String.fromCharCode(0)}here`,
                messages: [{ role: 'tool', content: [{ type: 'tool-result', toolCallId: 'c', toolName: 'readChannelMessages', output: { type: 'json', value: { text: halfAnEmoji } } }] }],
            }),
            now: NOON,
            keepTurns: 20,
        });

        const [stored] = await repo.listTurns(sessionId);
        expect(stored?.question).toBe('nulhere');
        expect(stored?.messages).toEqual([
            { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'c', toolName: 'readChannelMessages', output: { type: 'json', value: { text: 'so Damon \uFFFD' } } }] },
        ]);
    });

    it('refuses a turn that posted nothing', async () => {
        await expect(record(null, [])).rejects.toThrow('only once it has posted');
    });
});
