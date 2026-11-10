import type { ModelMessage } from 'ai';
import { describe, expect, it } from 'vitest';
import { historyToModelMessages, type HistoryMessage, type TurnTrace } from '../historyToModelMessages';

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

const NO_TRACES = () => undefined;
const VEX = 'vex-id';

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

describe('historyToModelMessages', () => {
    it('writes people as user lines naming who, when and whom they reply to, marking the one being answered', () => {
        const messages = historyToModelMessages(
            [said('1', 'Vex', 'anyone up?'), asked('2', 'Mara', 'always')].map((message, index) =>
                index === 1 ? { ...message, replyToAuthorName: 'Vex' } : message
            ),
            NO_TRACES,
            VEX
        );
        expect(messages).toEqual([
            { role: 'user', content: '[2026-11-06 21:04] Vex: anyone up?' },
            { role: 'user', content: '→ [2026-11-06 21:04] Mara (replying to Vex): always' },
        ]);
    });

    it('marks other bots so the agent does not mistake them for people', () => {
        const [message] = historyToModelMessages([asked('1', 'Carl', 'beep')].map((m) => ({ ...m, isFromOtherBot: true })), NO_TRACES, VEX);
        expect(message).toEqual({ role: 'user', content: '→ [2026-11-06 21:04] Carl [bot]: beep' });
    });

    it("makes the bot's own untraced messages assistant turns", () => {
        const messages = historyToModelMessages([said('1', 'Vex', 'hi bot'), botSaid('2', 'Hi human.'), asked('3', 'Vex', 'rude')], NO_TRACES, VEX);
        expect(messages[1]).toEqual({ role: 'assistant', content: 'Hi human.' });
    });

    it('replaces a reply traced for this asker with its tool calls and results, and skips its continuation', () => {
        const traces = new Map<string, TurnTrace>([
            ['2', { askerId: VEX, messages: LOOKED_UP_RULES }],
            ['3', 'continuation'],
        ]);
        const messages = historyToModelMessages(
            [said('1', 'Vex', 'can I DM people?'), botSaid('2', 'Rule three'), botSaid('3', '…twice.'), asked('4', 'Vex', 'ok')],
            (id) => traces.get(id),
            VEX
        );
        expect(messages).toEqual([
            { role: 'user', content: '[2026-11-06 21:04] Vex: can I DM people?' },
            ...LOOKED_UP_RULES,
            { role: 'user', content: '→ [2026-11-06 21:04] Vex: ok' },
        ]);
    });

    it("never shows one asker's tool results while answering another — only the reply's text", () => {
        const traces = new Map<string, TurnTrace>([['2', { askerId: 'mod-id', messages: LOOKED_UP_RULES }]]);
        const messages = historyToModelMessages(
            [said('1', 'Mara', 'list the channels'), botSaid('2', 'Here you go.'), asked('3', 'Vex', 'what did you just look up?')],
            (id) => traces.get(id),
            VEX
        );
        expect(messages).toEqual([
            { role: 'user', content: '[2026-11-06 21:04] Mara: list the channels' },
            { role: 'assistant', content: 'Here you go.' },
            { role: 'user', content: '→ [2026-11-06 21:04] Vex: what did you just look up?' },
        ]);
        expect(JSON.stringify(messages)).not.toContain('tool-result');
    });

    it('keeps what was said after the message being answered, such as a reply to someone else', () => {
        const messages = historyToModelMessages(
            [asked('1', 'Vex', 'where do selfies go?'), botSaid('2', '#selfies, Mara.')],
            NO_TRACES,
            VEX
        );
        expect(messages.map((message) => message.role)).toEqual(['user', 'assistant']);
    });

    it('drops the oldest turns past the budget but never the one being answered or what follows', () => {
        const history = [
            said('1', 'Vex', 'x'.repeat(500)),
            said('2', 'Mara', 'y'.repeat(500)),
            asked('3', 'Vex', 'z'.repeat(5000)),
            said('4', 'Mara', 'and after'),
        ];
        const messages = historyToModelMessages(history, NO_TRACES, VEX, 1_200);
        expect(messages).toHaveLength(2);
        expect(String(messages[0].content)).toContain('zzz');
        expect(String(messages[1].content)).toContain('and after');
    });

    it('never opens on an assistant turn after trimming', () => {
        const history = [said('1', 'Vex', 'x'.repeat(2000)), botSaid('2', 'short'), asked('3', 'Vex', 'and?')];
        const messages = historyToModelMessages(history, NO_TRACES, VEX, 200);
        expect(messages[0].role).toBe('user');
        expect(messages).toHaveLength(1);
    });
});
