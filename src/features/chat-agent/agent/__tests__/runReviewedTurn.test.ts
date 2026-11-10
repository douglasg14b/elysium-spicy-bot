import { MockLanguageModelV4 } from 'ai/test';
import type { Guild, GuildMember, GuildTextBasedChannel } from 'discord.js';
import { describe, expect, it } from 'vitest';
import type { ReviewContext } from '../../output/replyReview';
import type { ChatTools } from '../../tools/buildChatTools';
import type { ChatToolContext } from '../../tools/chatToolContext';
import { runReviewedTurn } from '../runReviewedTurn';

const USAGE = {
    inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: 5, text: 5, reasoning: undefined },
};

/** A server with no channels, members or roles: nothing links, so a #name is made up. */
const guild = { id: 'guild', name: 'Elysium', channels: { cache: new Map() }, members: { cache: new Map() }, roles: { cache: new Map() } };
const vex = { id: 'vex', displayName: 'Vex', guild } as unknown as GuildMember;
const CONTEXT: ChatToolContext = {
    guild: guild as unknown as Guild,
    channel: { id: 'channel', name: 'general', nsfw: false } as unknown as GuildTextBasedChannel,
    asker: vex,
    viewers: [vex],
    viewersCanReadHistory: true,
    ticket: null,
    contextChannels: [],
    serverNotes: '',
    botRules: '',
};
const REVIEW: ReviewContext = { viewers: [vex], inTicket: false, botName: 'BrattyBot', toolNames: [] };

/** A model answering each call with the next of `replies`, remembering the prompts it was sent. */
function modelReplying(...replies: string[]) {
    return new MockLanguageModelV4({
        doGenerate: replies.map((text) => ({
            content: [{ type: 'text' as const, text }],
            finishReason: { unified: 'stop' as const, raw: undefined },
            usage: USAGE,
            warnings: [],
        })),
    });
}

function run(model: MockLanguageModelV4) {
    return runReviewedTurn(
        { context: CONTEXT, tools: {} as ChatTools, messages: [{ role: 'user', content: '→ Vex: where do selfies go?' }], model, botName: 'BrattyBot' },
        REVIEW
    );
}

describe('runReviewedTurn', () => {
    it('posts a good first reply without asking again', async () => {
        const model = modelReplying('Ask a mod.');
        expect(await run(model)).toMatchObject({ outcome: 'post', parts: ['Ask a mod.'], redone: null });
        expect(model.doGenerateCalls).toHaveLength(1);
    });

    it('turns a bad reply back once, telling the model what was wrong, and posts the fixed one', async () => {
        const model = modelReplying('Oh, darling, try #nsfw-chat.', 'Ask a mod.');

        const reviewed = await run(model);

        expect(reviewed).toMatchObject({
            outcome: 'post',
            parts: ['Ask a mod.'],
            redone: { problems: [{ kind: 'petName', word: 'darling' }, { kind: 'unknownChannel', names: ['nsfw-chat'] }] },
        });
        const secondPrompt = JSON.stringify(model.doGenerateCalls[1]?.prompt);
        expect(secondPrompt).toContain('Oh, darling, try #nsfw-chat.');
        expect(secondPrompt).toContain('Not posted: it called them \\"darling\\"');
    });

    it('falls back when the second reply is still wrong', async () => {
        const model = modelReplying('', '   ');
        expect(await run(model)).toMatchObject({ outcome: 'fallback', problems: [{ kind: 'empty' }] });
        expect(model.doGenerateCalls).toHaveLength(2);
    });

    it('posts a made-up channel without its # when it persists, rather than losing the reply', async () => {
        const model = modelReplying('Try #nsfw-chat.', 'Try #nsfw-chat, really.');
        expect(await run(model)).toMatchObject({ outcome: 'post', parts: ['Try nsfw-chat, really.'] });
    });
});
