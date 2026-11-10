import type { ModelMessage } from 'ai';
import { describe, expect, it } from 'vitest';
import { historyToModelMessages, type EarlierTurn, type HistoryMessage, type SessionMemory, type SessionPost } from '../historyToModelMessages';

function said(id: string, authorName: string, content: string, extra: Partial<HistoryMessage> = {}): HistoryMessage {
    return {
        id,
        authorName,
        isFromThisBot: false,
        isFromOtherBot: false,
        content,
        createdAt: new Date('2026-11-06T21:04:00Z'),
        replyToAuthorName: undefined,
        isBeingAnswered: false,
        ...extra,
    };
}

const asked = (id: string, authorName: string, content: string) => said(id, authorName, content, { isBeingAnswered: true });
const botSaid = (id: string, content: string) => said(id, 'BrattyBot', content, { isFromThisBot: true });

function session(posts: Record<string, SessionPost>, earlier: readonly EarlierTurn[] = []): SessionMemory {
    return { postFor: (id) => posts[id], earlier };
}

const LOOKED_UP_RULES: readonly ModelMessage[] = [
    {
        role: 'assistant',
        content: [{ type: 'tool-call', toolCallId: 'call-1', toolName: 'getServerRules', input: {} }],
    },
    {
        role: 'tool',
        content: [
            {
                type: 'tool-result',
                toolCallId: 'call-1',
                toolName: 'getServerRules',
                output: { type: 'json', value: { found: true } },
            },
        ],
    },
    { role: 'assistant', content: 'Rule three: ask before you DM. Read it twice.' },
];

/** A trace whose one tool result is `size` characters of rules. */
function lookedUpLong(size: number): ModelMessage[] {
    return [
        LOOKED_UP_RULES[0],
        {
            role: 'tool',
            content: [{ type: 'tool-result', toolCallId: 'call-1', toolName: 'getServerRules', output: { type: 'json', value: { rules: 'r'.repeat(size) } } }],
        },
        LOOKED_UP_RULES[2],
    ];
}

const BUDGETS = (chat: number, traces: number) => ({ chat, traces });

describe('historyToModelMessages', () => {
    it('writes people as user lines naming who, when and whom they reply to, marking the one being answered', () => {
        const messages = historyToModelMessages(
            [said('1', 'Vex', 'anyone up?'), asked('2', 'Mara', 'always')].map((message, index) =>
                index === 1 ? { ...message, replyToAuthorName: 'Vex' } : message
            )
        );
        expect(messages).toEqual([
            { role: 'user', content: '[2026-11-06 21:04] Vex: anyone up?' },
            { role: 'user', content: '→ [2026-11-06 21:04] Mara (replying to Vex): always' },
        ]);
    });

    it('marks other bots so the agent does not mistake them for people', () => {
        const [message] = historyToModelMessages([asked('1', 'Carl', 'beep')].map((m) => ({ ...m, isFromOtherBot: true })));
        expect(message).toEqual({ role: 'user', content: '→ [2026-11-06 21:04] Carl [bot]: beep' });
    });

    it("makes the bot's own untraced messages assistant turns", () => {
        const messages = historyToModelMessages([said('1', 'Vex', 'hi bot'), botSaid('2', 'Hi human.'), asked('3', 'Vex', 'rude')]);
        expect(messages[1]).toEqual({ role: 'assistant', content: 'Hi human.' });
    });

    it('replaces a traced reply with its tool calls and results — whoever asks now — and skips its continuation', () => {
        const messages = historyToModelMessages(
            [said('1', 'Mara', 'can I DM people?'), botSaid('2', 'Rule three'), botSaid('3', '…twice.'), asked('4', 'Vex', 'ok')],
            session({ '2': { kind: 'traced', trace: LOOKED_UP_RULES, question: '[2026-11-06 21:04] Mara: can I DM people?', questionId: '1' }, '3': { kind: 'continuation', of: '2' } })
        );
        expect(messages).toEqual([
            { role: 'user', content: '[2026-11-06 21:04] Mara: can I DM people?' },
            ...LOOKED_UP_RULES,
            { role: 'user', content: '→ [2026-11-06 21:04] Vex: ok' },
        ]);
    });

    it("puts the session's turns from before the window first, as their question and trace", () => {
        const messages = historyToModelMessages(
            [said('5', 'Mara', 'lol'), asked('6', 'Vex', 'and rule four?')],
            session({}, [{ question: '[2026-11-06 20:01] Kat: can I DM people?', answer: 'Rule three.', trace: LOOKED_UP_RULES }])
        );
        expect(messages).toEqual([
            { role: 'user', content: '[2026-11-06 20:01] Kat: can I DM people?' },
            ...LOOKED_UP_RULES,
            { role: 'user', content: '[2026-11-06 21:04] Mara: lol' },
            { role: 'user', content: '→ [2026-11-06 21:04] Vex: and rule four?' },
        ]);
    });

    it('shows an earlier turn whose trace may not be shown as its question and answer', () => {
        const messages = historyToModelMessages(
            [asked('6', 'Vex', 'and rule four?')],
            session({}, [{ question: '[2026-11-06 20:01] Kat: can I DM people?', answer: 'Rule three.', trace: undefined }])
        );
        expect(messages.slice(0, 2)).toEqual([
            { role: 'user', content: '[2026-11-06 20:01] Kat: can I DM people?' },
            { role: 'assistant', content: 'Rule three.' },
        ]);
    });

    it('keeps what was said after the message being answered, such as a reply to someone else', () => {
        const messages = historyToModelMessages([asked('1', 'Vex', 'where do selfies go?'), botSaid('2', '#selfies, Mara.')]);
        expect(messages.map((message) => message.role)).toEqual(['user', 'assistant']);
    });

    it('drops the oldest turns past the chat budget but never the one being answered or what follows', () => {
        const history = [
            said('1', 'Vex', 'x'.repeat(500)),
            said('2', 'Mara', 'y'.repeat(500)),
            asked('3', 'Vex', 'z'.repeat(5000)),
            said('4', 'Mara', 'and after'),
        ];
        const messages = historyToModelMessages(history, undefined, BUDGETS(1_200, 60_000));
        expect(messages).toHaveLength(2);
        expect(String(messages[0].content)).toContain('zzz');
        expect(String(messages[1].content)).toContain('and after');
    });

    it('never opens on an assistant turn after trimming', () => {
        const history = [said('1', 'Vex', 'x'.repeat(2000)), botSaid('2', 'short'), asked('3', 'Vex', 'and?')];
        const messages = historyToModelMessages(history, undefined, BUDGETS(200, 60_000));
        expect(messages[0].role).toBe('user');
        expect(messages).toHaveLength(1);
    });

    it("spends traces from their own budget, so a lookup outlives the chatter that fills the chat's", () => {
        const history = [said('1', 'Vex', 'rules?'), botSaid('2', 'Rule three.'), said('3', 'Mara', 'x'.repeat(900)), asked('4', 'Vex', 'and?')];
        const messages = historyToModelMessages(history, session({ '2': { kind: 'traced', trace: lookedUpLong(3_000), question: '[2026-11-06 21:04] Vex: rules?', questionId: '1' } }), BUDGETS(1_000, 5_000));

        // The chatter was too much for the chat budget; the trace still fit its own, led by its question.
        expect(messages).toEqual([
            { role: 'user', content: '[2026-11-06 21:04] Vex: rules?' },
            ...lookedUpLong(3_000),
            { role: 'user', content: '→ [2026-11-06 21:04] Vex: and?' },
        ]);
    });

    it('leads a trace with its question whenever the question itself was trimmed away, even before the chat budget ran out', () => {
        // Newest first: the trace fits its budget while the chat has room, then the long question does not.
        const history = [said('1', 'Vex', 'x'.repeat(900)), botSaid('2', 'Rule three.'), asked('3', 'Vex', 'and?')];
        const messages = historyToModelMessages(
            history,
            session({ '2': { kind: 'traced', trace: LOOKED_UP_RULES, question: '[2026-11-06 21:04] Vex: rules? (shortened)', questionId: '1' } }),
            BUDGETS(500, 5_000)
        );

        expect(messages).toEqual([{ role: 'user', content: '[2026-11-06 21:04] Vex: rules? (shortened)' }, ...LOOKED_UP_RULES, { role: 'user', content: '→ [2026-11-06 21:04] Vex: and?' }]);
    });

    it("keeps reaching back past dropped chatter for older traces — the session's earlier turns too", () => {
        const history = [said('1', 'Vex', 'rules?'), botSaid('2', 'Rule three.'), said('3', 'Mara', 'x'.repeat(900)), asked('4', 'Vex', 'and?')];
        const earlier = [{ question: '[2026-11-06 20:00] Kat: rule one?', answer: '18+.', trace: LOOKED_UP_RULES }];
        const messages = historyToModelMessages(
            history,
            session({ '2': { kind: 'traced', trace: LOOKED_UP_RULES, question: '[2026-11-06 21:04] Vex: rules?', questionId: '1' } }, earlier),
            BUDGETS(1_000, 5_000)
        );

        expect(messages[0]).toEqual({ role: 'user', content: '[2026-11-06 20:00] Kat: rule one?' });
        expect(JSON.stringify(messages)).not.toContain('xxxx');
    });

    it('notes away the largest results of a trace too big for what is left, keeping the calls and the answer', () => {
        const history = [said('1', 'Vex', 'rules?'), botSaid('2', 'Rule three.'), asked('3', 'Vex', 'and?')];
        const messages = historyToModelMessages(history, session({ '2': { kind: 'traced', trace: lookedUpLong(5_000), question: 'q', questionId: 'q' } }), BUDGETS(1_000, 2_000));

        expect(JSON.stringify(messages)).not.toContain('rrrr');
        expect(JSON.stringify(messages)).toContain('Not kept: call getServerRules again if you need it.');
        expect(messages).toContainEqual(LOOKED_UP_RULES[2]);
    });

    it("keeps a trace with no room at all as its plain text, a split reply's parts joined, so the conversation before it stays", () => {
        const history = [said('1', 'Vex', 'what was ticket 57 about?'), botSaid('2', 'River vs Damon,'), botSaid('3', 'final warning.'), asked('4', 'Vex', 'and before that?')];
        const messages = historyToModelMessages(
            history,
            session({ '2': { kind: 'traced', trace: lookedUpLong(100), question: 'q', questionId: 'q' }, '3': { kind: 'continuation', of: '2' } }),
            BUDGETS(1_000, 50)
        );

        expect(messages).toEqual([
            { role: 'user', content: expect.stringContaining('ticket 57') },
            { role: 'assistant', content: 'River vs Damon,\nfinal warning.' },
            { role: 'user', content: expect.stringContaining('and before that?') },
        ]);
    });
});
