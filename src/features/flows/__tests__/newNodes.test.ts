import { EmbedBuilder } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';
import {
    block as actionPostEmbedNode,
    hexColorToInt,
    postEmbedConfigSchema,
    type PostEmbedConfig,
} from '../blocks/actionPostEmbed';
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
        runId: 'run-1',
        nodeId: 'node-1',
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
            runId: 'run-1',
            nodeId: 'node-1',
            variables: {},
            setOutput: () => {},
        };
    }

    /**
     * A config as the executor hands one over: through the schema, so declared
     * defaults are applied.
     *
     * The literals below are deliberately the *stored* shape — which for most of
     * these is the shape a graph saved before this block grew fields still holds —
     * so parsing them here is also the check that such a graph still runs.
     */
    function parseConfig(stored: Record<string, unknown>): PostEmbedConfig {
        return postEmbedConfigSchema.parse(stored);
    }

    it('sends an embed built from the configured title, description and colour', async () => {
        const send = vi.fn().mockResolvedValue({ id: 'message-1' });
        const context = contextWithChannel(send);

        const outcome = await actionPostEmbedNode.run(
            parseConfig({
                channelId: CHANNEL_ID,
                title: 'Spicy News',
                description: 'The dungeon reopens at midnight.',
                color: '#00A2FF',
            }),
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
            parseConfig({ channelId: CHANNEL_ID, title: 'Plain', description: 'No colour here.' }),
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
            runId: 'run-1',
            nodeId: 'node-1',
            variables: {},
            setOutput: () => {},
        };

        await expect(
            actionPostEmbedNode.run(
                parseConfig({ channelId: CHANNEL_ID, title: 'T', description: 'D' }),
                context
            )
        ).rejects.toThrow(/not a sendable text channel/);
    });

    it('converts a hex colour string to the integer discord.js expects', () => {
        expect(hexColorToInt('#00A2FF')).toBe(0x00a2ff);
        expect(hexColorToInt('#000000')).toBe(0);
        expect(hexColorToInt('#ffffff')).toBe(0xffffff);
    });

    it('builds the fields and flat scalars an author configured', async () => {
        const send = vi.fn().mockResolvedValue({ id: 'message-1' });

        await actionPostEmbedNode.run(
            parseConfig({
                channelId: CHANNEL_ID,
                title: 'House Rules',
                description: 'Read them.',
                url: 'https://example.com/rules',
                authorName: 'The Management',
                imageUrl: 'https://example.com/banner.png',
                thumbnailUrl: 'https://example.com/icon.png',
                footerText: 'Behave yourselves.',
                showTimestamp: 'true',
                fields: [
                    { name: 'Safewords', value: 'Red means stop.', inline: true },
                    { name: 'Consent', value: 'Enthusiastic, or not at all.' },
                ],
            }),
            contextWithChannel(send)
        );

        const payload = send.mock.calls[0]?.[0] as { embeds: EmbedBuilder[] };
        const embed = payload.embeds[0]?.data;

        expect(embed?.url).toBe('https://example.com/rules');
        expect(embed?.author?.name).toBe('The Management');
        expect(embed?.image?.url).toBe('https://example.com/banner.png');
        expect(embed?.thumbnail?.url).toBe('https://example.com/icon.png');
        expect(embed?.footer?.text).toBe('Behave yourselves.');
        expect(embed?.timestamp).toEqual(expect.any(String));
        // `inline` defaults to false rather than being left absent, so the two
        // rows differ in the one way the author actually set.
        expect(embed?.fields).toEqual([
            { name: 'Safewords', value: 'Red means stop.', inline: true },
            { name: 'Consent', value: 'Enthusiastic, or not at all.', inline: false },
        ]);
    });

    /**
     * A field whose text was entirely a token that resolved to nothing.
     *
     * `.min(1)` passes at save — `{{var.missing}}` is 17 characters — and the
     * value is empty by the time it reaches Discord, which rejects a blank field
     * side with a 400 naming `embeds.0.fields.0.name` and nothing an author could
     * act on. discord.js checks the title and footer for this and not a field's
     * two halves, so it is the block's to catch.
     */
    it('fails naming the row when a field resolves to an empty heading or text', async () => {
        const send = vi.fn().mockResolvedValue({ id: 'message-1' });

        const outcome = await actionPostEmbedNode.run(
            parseConfig({
                channelId: CHANNEL_ID,
                title: 'T',
                description: 'D',
                fields: [
                    { name: 'Fine', value: 'Also fine.' },
                    { name: 'Blank', value: '   ' },
                ],
            }),
            contextWithChannel(send)
        );

        expect(outcome).toEqual({
            kind: 'fail',
            // One-based, matching the form the author is looking at.
            error: expect.stringContaining('Field 2'),
        });
        expect(send).not.toHaveBeenCalled();
    });

    /**
     * The one limit no single field can carry, and the reason it is checked in
     * `run` rather than in the schema: every part here is comfortably within its
     * own cap, and only the total is over.
     */
    it('fails naming the total when the whole embed exceeds Discord 6000 characters', async () => {
        const send = vi.fn().mockResolvedValue({ id: 'message-1' });

        const outcome = await actionPostEmbedNode.run(
            parseConfig({
                channelId: CHANNEL_ID,
                title: 'T',
                description: 'd'.repeat(4000),
                fields: Array.from({ length: 3 }, (_entry, index) => ({
                    name: `Field ${index}`,
                    value: 'v'.repeat(1000),
                })),
            }),
            contextWithChannel(send)
        );

        expect(outcome).toEqual({
            kind: 'fail',
            error: expect.stringContaining('6000'),
        });
        // Nothing is posted: a partially-trimmed embed would read as the flow
        // being broken rather than as the embed being too long.
        expect(send).not.toHaveBeenCalled();
    });
});
