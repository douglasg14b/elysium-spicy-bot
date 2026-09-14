import { EmbedBuilder } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';
import { block as actionPostEmbedNode, hexColorToInt } from '../blocks/actionPostEmbed';
import { block as conditionInChannelNode } from '../blocks/conditionInChannel';
import type { FlowRunContext } from '../blocks/types';

const CHANNEL_ID = 'channel-abc';

/** A context operating in `channelId`, or nowhere at all when none is given. */
function contextInChannel(channelId?: string): FlowRunContext {
    return {
        client: {} as FlowRunContext['client'],
        guild: { id: 'guild-1' } as FlowRunContext['guild'],
        subject: {} as FlowRunContext['subject'],
        channel: channelId ? ({ id: channelId } as FlowRunContext['channel']) : undefined,
        variables: {},
        setOutput: () => {},
    };
}

describe('condition.inChannel', () => {
    it('leaves by the true handle when the run is operating in the configured channel', async () => {
        const outcome = await conditionInChannelNode.run(
            { channelId: CHANNEL_ID },
            contextInChannel(CHANNEL_ID)
        );

        expect(outcome).toEqual({ kind: 'continue', handle: 'true' });
    });

    it('leaves by the false handle when the run is in a different channel', async () => {
        const outcome = await conditionInChannelNode.run(
            { channelId: CHANNEL_ID },
            contextInChannel('some-other-channel')
        );

        expect(outcome).toEqual({ kind: 'continue', handle: 'false' });
    });

    it('leaves by the false handle when the run has no channel at all', async () => {
        const outcome = await conditionInChannelNode.run({ channelId: CHANNEL_ID }, contextInChannel());

        expect(outcome).toEqual({ kind: 'continue', handle: 'false' });
    });

    it('answers from the run rather than from the interaction', async () => {
        // The point of the retarget. A run can be operating in a channel while
        // carrying no interaction at all — a reaction-started run is exactly that
        // shape — and the old block, which read `context.interaction?.channelId`,
        // answered "no" for every one of them regardless of the truth.
        const noInteraction: FlowRunContext = {
            ...contextInChannel(CHANNEL_ID),
            interaction: undefined,
        };

        const outcome = await conditionInChannelNode.run({ channelId: CHANNEL_ID }, noInteraction);

        expect(outcome).toEqual({ kind: 'continue', handle: 'true' });
    });
});

describe('action.postEmbed', () => {
    function contextWithChannel(send: ReturnType<typeof vi.fn>): FlowRunContext {
        const channel = { isTextBased: () => true, send };
        return {
            client: {
                channels: { fetch: vi.fn().mockResolvedValue(channel) },
            } as unknown as FlowRunContext['client'],
            guild: { id: 'guild-1' } as FlowRunContext['guild'],
            subject: {} as FlowRunContext['subject'],
            variables: {},
            setOutput: () => {},
        };
    }

    it('sends an embed built from the configured title, description and colour', async () => {
        const send = vi.fn().mockResolvedValue({ id: 'message-1' });
        const context = contextWithChannel(send);

        const outcome = await actionPostEmbedNode.run(
            {
                channelId: CHANNEL_ID,
                title: 'Spicy News',
                description: 'The dungeon reopens at midnight.',
                color: '#00A2FF',
            },
            context
        );

        expect(outcome).toEqual({ kind: 'continue' });

        expect(send).toHaveBeenCalledTimes(1);
        const payload = send.mock.calls[0]?.[0] as { embeds: EmbedBuilder[] };
        expect(payload.embeds).toHaveLength(1);

        const embed = payload.embeds[0];
        expect(embed).toBeInstanceOf(EmbedBuilder);
        expect(embed?.data.title).toBe('Spicy News');
        expect(embed?.data.description).toBe('The dungeon reopens at midnight.');
        expect(embed?.data.color).toBe(0x00a2ff);
    });

    it('omits the colour when none is configured', async () => {
        const send = vi.fn().mockResolvedValue({ id: 'message-1' });

        await actionPostEmbedNode.run(
            { channelId: CHANNEL_ID, title: 'Plain', description: 'No colour here.' },
            contextWithChannel(send)
        );

        const payload = send.mock.calls[0]?.[0] as { embeds: EmbedBuilder[] };
        expect(payload.embeds[0]?.data.color).toBeUndefined();
    });

    it('throws when the target channel is not a sendable text channel', async () => {
        const context = {
            client: {
                channels: { fetch: vi.fn().mockResolvedValue(null) },
            } as unknown as FlowRunContext['client'],
            guild: { id: 'guild-1' } as FlowRunContext['guild'],
            subject: {} as FlowRunContext['subject'],
            variables: {},
            setOutput: () => {},
        };

        await expect(
            actionPostEmbedNode.run({ channelId: CHANNEL_ID, title: 'T', description: 'D' }, context)
        ).rejects.toThrow(/not a sendable text channel/);
    });

    it('converts a hex colour string to the integer discord.js expects', () => {
        expect(hexColorToInt('#00A2FF')).toBe(0x00a2ff);
        expect(hexColorToInt('#000000')).toBe(0);
        expect(hexColorToInt('#ffffff')).toBe(0xffffff);
    });
});
