import { MockLanguageModelV4 } from 'ai/test';
import type { Guild, GuildMember, GuildTextBasedChannel } from 'discord.js';
import { describe, expect, it } from 'vitest';
import type { TicketEntity } from '../../../tickets';
import type { ChatToolContext } from '../../tools/chatToolContext';
import { buildChatTools } from '../../tools/buildChatTools';
import { runChatTurn } from '../runChatTurn';

const USAGE = {
    inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: 5, text: 5, reasoning: undefined },
};

function ticketChannelContext(): ChatToolContext {
    const ticket = {
        ticketNumber: 42,
        type: 'support',
        status: 'open',
        title: 'Verification',
        reason: 'Need my selfie checked',
        subjectNickname: 'Vex',
        subjectUsername: 'vex_irl',
        claimerId: 'mod-id',
        claimerNickname: null,
        claimerUsername: 'Mara',
        openedAt: new Date('2026-11-06T20:00:00Z'),
    } as unknown as TicketEntity;
    return {
        guild: { id: 'guild', name: 'Elysium' } as unknown as Guild,
        channel: { id: 'channel', name: 's42-support-vex', nsfw: false } as unknown as GuildTextBasedChannel,
        asker: { id: 'vex-id', displayName: 'Vex' } as unknown as GuildMember,
        viewers: [{ id: 'vex-id', displayName: 'Vex' } as unknown as GuildMember],
        viewersCanReadHistory: true,
        ticket,
        contextChannels: [],
        serverNotes: '',
        botRules: '',
        staffRoleIds: [],
    };
}

describe('runChatTurn', () => {
    it("looks up the ticket with this turn's context, then answers from what it found", async () => {
        const model = new MockLanguageModelV4({
            doGenerate: [
                {
                    content: [{ type: 'tool-call', toolCallId: 'call-1', toolName: 'getTicketInfo', input: '{}' }],
                    finishReason: { unified: 'tool-calls', raw: undefined },
                    usage: USAGE,
                    warnings: [],
                },
                {
                    content: [{ type: 'text', text: "Mara's got your ticket. Sit tight." }],
                    finishReason: { unified: 'stop', raw: undefined },
                    usage: USAGE,
                    warnings: [],
                },
            ],
        });

        const context = ticketChannelContext();
        const turn = await runChatTurn({
            context,
            tools: buildChatTools(context),
            messages: [{ role: 'user', content: '[2026-11-06 21:04] Vex: who has my ticket?' }],
            model,
            botName: 'BrattyBot',
        });

        expect(turn.text).toBe("Mara's got your ticket. Sit tight.");
        expect(turn.toolCalls).toEqual(['getTicketInfo']);
        expect(turn.steps).toBe(2);

        const toolResult = turn.responseMessages
            .filter((message) => message.role === 'tool')
            .flatMap((message) => message.content)
            .find((part) => part.type === 'tool-result');
        expect(toolResult).toMatchObject({
            toolName: 'getTicketInfo',
            output: { type: 'json', value: { isTicket: true, number: 42, claimedBy: 'Mara', openedFor: 'Vex' } },
        });
        expect(turn.responseMessages.at(-1)).toMatchObject({ role: 'assistant' });
    });

    it('tells the model where it is and who it is talking to, in ticket mode', async () => {
        const model = new MockLanguageModelV4({
            doGenerate: {
                content: [{ type: 'text', text: 'Hi.' }],
                finishReason: { unified: 'stop', raw: undefined },
                usage: USAGE,
                warnings: [],
            },
        });

        const context = ticketChannelContext();
        await runChatTurn({
            context,
            tools: buildChatTools(context),
            messages: [{ role: 'user', content: 'hi' }],
            model,
            botName: 'BrattyBot',
        });

        const [call] = model.doGenerateCalls;
        const system = call.prompt.find((message) => message.role === 'system');
        expect(system?.content).toContain('support ticket');
        expect(system?.content).toContain('Speaking to you: Vex\n');
        expect(system?.content).toContain('Channel: #s42-support-vex');
        expect(call.tools?.map((tool) => tool.name).sort()).toEqual(
            [
                'getBotFeature',
                'getChannelInfo',
                'getMemberInfo',
                'getServerInfo',
                'getServerRules',
                'readContextChannel',
                'getTicketInfo',
                'getUserLevel',
                'listChannels',
                'searchRecentMessages',
                'stayQuiet',
            ].sort()
        );
    });

    it('offers stayQuiet only in a ticket — anywhere else a mention always gets an answer', async () => {
        const model = new MockLanguageModelV4({
            doGenerate: {
                content: [{ type: 'text', text: 'Hi.' }],
                finishReason: { unified: 'stop', raw: undefined },
                usage: USAGE,
                warnings: [],
            },
        });
        const context = { ...ticketChannelContext(), ticket: null };

        await runChatTurn({ context, tools: buildChatTools(context), messages: [{ role: 'user', content: 'hi' }], model, botName: 'BrattyBot' });

        const [call] = model.doGenerateCalls;
        expect(call.tools?.map((tool) => tool.name)).not.toContain('stayQuiet');
        expect(call.prompt.find((message) => message.role === 'system')?.content).not.toContain('support ticket');
    });

    it('stops at stayQuiet and reports it, with no text to post', async () => {
        const model = new MockLanguageModelV4({
            doGenerate: [
                {
                    content: [{ type: 'tool-call', toolCallId: 'call-1', toolName: 'stayQuiet', input: '{"reason":"flirting"}' }],
                    finishReason: { unified: 'tool-calls', raw: undefined },
                    usage: USAGE,
                    warnings: [],
                },
                {
                    content: [{ type: 'text', text: 'should never be generated' }],
                    finishReason: { unified: 'stop', raw: undefined },
                    usage: USAGE,
                    warnings: [],
                },
            ],
        });
        const context = ticketChannelContext();

        const turn = await runChatTurn({ context, tools: buildChatTools(context), messages: [{ role: 'user', content: 'step on me' }], model, botName: 'BrattyBot' });

        expect(turn.stayedQuiet).toBe(true);
        expect(turn.text).toBe('');
        expect(model.doGenerateCalls).toHaveLength(1);
    });
});
