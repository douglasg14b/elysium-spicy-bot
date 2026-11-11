import { MockLanguageModelV4 } from 'ai/test';
import type { Guild, GuildMember, GuildTextBasedChannel } from 'discord.js';
import { describe, expect, it } from 'vitest';
import type { TicketEntity } from '../../../tickets';
import type { ChatToolContext } from '../../tools/chatToolContext';
import { buildChatTools } from '../../tools/buildChatTools';
import { MAX_AGENT_STEPS, runChatTurn, STAFF_MAX_AGENT_STEPS, turnLimitsFor } from '../runChatTurn';

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
        asker: { id: 'vex-id', displayName: 'Vex', guild: { id: 'guild' }, roles: { cache: new Map() } } as unknown as GuildMember,
        viewers: [{ id: 'vex-id', displayName: 'Vex' } as unknown as GuildMember],
        viewersCanReadHistory: true,
        ticket,
        contextChannels: [],
        serverNotes: '',
        botRules: '',
        staffRoleIds: [],
        introsChannelId: null,
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
        expect(system?.content).toContain('Speaking to you: Vex (no pronoun role — "they" until you know otherwise)\n');
        expect(system?.content).toContain('Channel: #s42-support-vex');
        expect(call.tools?.map((tool) => tool.name).sort()).toEqual(
            [
                'findTickets',
                'getBotFeature',
                'getChannelAccess',
                'getChannelInfo',
                'getMemberInfo',
                'getServerInfo',
                'getServerRules',
                'readChannelMessages',
                'readContextChannel',
                'getTicketInfo',
                'getUserLevel',
                'getMemberIntro',
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

describe('runChatTurn step limit', () => {
    /** A model that never stops looking things up. */
    const lookingForever = () =>
        new MockLanguageModelV4({
            doGenerate: async () => ({
                content: [{ type: 'tool-call', toolCallId: `call-${Math.random()}`, toolName: 'getTicketInfo', input: '{}' }],
                finishReason: { unified: 'tool-calls', raw: undefined },
                usage: USAGE,
                warnings: [],
            }),
        });
    const runWith = (maxSteps?: number) => {
        const context = ticketChannelContext();
        return runChatTurn({
            context,
            tools: buildChatTools(context),
            messages: [{ role: 'user', content: '[2026-11-06 21:04] Vex: dig' }],
            model: lookingForever(),
            botName: 'BrattyBot',
            maxSteps,
        });
    };

    it(`stops at ${MAX_AGENT_STEPS} rounds unless the caller allows more`, async () => {
        expect((await runWith()).steps).toBe(MAX_AGENT_STEPS);
        expect((await runWith(STAFF_MAX_AGENT_STEPS)).steps).toBe(STAFF_MAX_AGENT_STEPS);
    });
});

describe('turnLimitsFor', () => {
    const guild = { ownerId: 'owner', memberCount: 2, members: { cache: { size: 2 } } };
    const member = (id: string) =>
        ({ id, guild, permissions: { has: () => false }, roles: { cache: new Map() } }) as unknown as GuildMember;
    const limitsAmong = (...ids: string[]) =>
        turnLimitsFor({ viewers: ids.map(member), staffRoleIds: [] } as unknown as ChatToolContext).maxSteps;

    it('gives a staff-only room room to page back, and every other turn the short leash', () => {
        expect(limitsAmong('owner')).toBe(STAFF_MAX_AGENT_STEPS);
        expect(limitsAmong('owner', 'vex')).toBe(MAX_AGENT_STEPS);
        expect(limitsAmong('vex')).toBe(MAX_AGENT_STEPS);
    });
});
