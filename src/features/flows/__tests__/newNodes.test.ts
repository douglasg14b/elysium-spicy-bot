import { EmbedBuilder } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';
import { block as actionPostEmbedNode, postEmbedConfigSchema, type PostEmbedConfig } from '../blocks/actionPostEmbed';
import { block as conditionInChannelNode } from '../blocks/conditionInChannel';
import type { FlowRunContext } from '../blocks/types';
import { fakeGuild } from './support/fakeGuild';

const CHANNEL_ID = 'channel-abc';

/**
 * A context operating in `channelId`, or nowhere at all when none is given — in a thread
 * under `threadParentId`, when one is given.
 */
function contextInChannel(channelId?: string, threadParentId?: string): FlowRunContext {
    const channel = channelId
        ? ({
              id: channelId,
              isThread: () => threadParentId !== undefined,
              parentId: threadParentId ?? null,
          } as unknown as FlowRunContext['channel'])
        : undefined;
    return {
        client: {} as FlowRunContext['client'],
        guild: { id: 'guild-1' } as FlowRunContext['guild'],
        subject: {} as FlowRunContext['subject'],
        channel,
        runId: 'run-1',
        flowId: 'flow-1',
        nodeId: 'node-1',
        chainDepth: 1,
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

    it('leaves by the true handle for a thread under the configured channel', async () => {
        // A thread counts toward its channel everywhere: a run Message Sent started for a
        // reply in a thread under #general is in #general.
        const outcome = await conditionInChannelNode.run(
            { channelId: CHANNEL_ID },
            contextInChannel('thread-under-it', CHANNEL_ID)
        );

        expect(outcome).toEqual({ kind: 'continue', handle: 'true' });
    });

    it('leaves by the false handle for a thread under some other channel', async () => {
        const outcome = await conditionInChannelNode.run(
            { channelId: CHANNEL_ID },
            contextInChannel('thread-elsewhere', 'some-other-channel')
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
        return {
            client: {} as FlowRunContext['client'],
            guild: fakeGuild({ channels: { [CHANNEL_ID]: { send } } }),
            subject: {} as FlowRunContext['subject'],
            runId: 'run-1',
            flowId: 'flow-1',
            nodeId: 'node-1',
            chainDepth: 1,
            variables: {},
            setOutput: () => {},
        };
    }

    /**
     * A config as the executor hands one over: through the schema, so declared defaults
     * (`fields`, `inline`, `timestamp`) are applied. `embeds` are given as stored.
     */
    function parseConfig(channelId: string, message: Record<string, unknown>): PostEmbedConfig {
        return postEmbedConfigSchema.parse({ channelId, message });
    }

    /** One embed holding a title and a body, plus whatever else a case adds. */
    function oneEmbed(extra: Record<string, unknown> = {}): Record<string, unknown> {
        return { embeds: [{ title: 'T', description: 'D', ...extra }] };
    }

    it('sends the plain text and every embed, with mentions pinned to users', async () => {
        const send = vi.fn().mockResolvedValue({ id: 'message-1' });

        const outcome = await actionPostEmbedNode.run(
            parseConfig(CHANNEL_ID, {
                content: 'Listen up.',
                embeds: [
                    { title: 'Spicy News', description: 'The dungeon reopens at midnight.', color: '#00A2FF' },
                    { description: 'No colour here.' },
                ],
            }),
            contextWithChannel(send)
        );

        expect(outcome).toEqual({ kind: 'continue' });
        expect(send).toHaveBeenCalledTimes(1);
        const payload = send.mock.calls[0]?.[0] as {
            content: string;
            embeds: EmbedBuilder[];
            files: unknown[];
            allowedMentions: unknown;
        };
        expect(payload.content).toBe('Listen up.');
        expect(payload.embeds.map((embed) => embed.data)).toEqual([
            { title: 'Spicy News', description: 'The dungeon reopens at midnight.', color: 0x00a2ff },
            { description: 'No colour here.' },
        ]);
        expect(payload.files).toEqual([]);
        // As Send Message pins them: the plain text is copy a member's name can reach.
        expect(payload.allowedMentions).toEqual({ parse: ['users'] });
    });

    it("never posts into a channel that is not in the run's own server, though the bot can see it", async () => {
        // The bot is in more than one server, so its client resolves a channel in any of
        // them. A flow naming another server's channel must not post there as the bot —
        // nor even ask Discord about it.
        const send = vi.fn().mockResolvedValue({ id: 'message-1' });
        const clientFetch = vi.fn().mockResolvedValue({ isDMBased: () => false, isTextBased: () => true, send });
        const context: FlowRunContext = {
            ...contextWithChannel(vi.fn()),
            client: { channels: { fetch: clientFetch } } as unknown as FlowRunContext['client'],
            guild: fakeGuild({ channels: {} }),
        };

        await expect(
            actionPostEmbedNode.run(parseConfig('another-servers-channel', oneEmbed()), context)
        ).rejects.toThrow(/not a sendable text channel in this server/);
        expect(clientFetch).not.toHaveBeenCalled();
        expect(send).not.toHaveBeenCalled();
    });

    it("still reaches this server's archived thread, which the cache does not hold", async () => {
        const send = vi.fn().mockResolvedValue({ id: 'message-1' });
        const context: FlowRunContext = {
            ...contextWithChannel(vi.fn()),
            guild: fakeGuild({ uncachedChannels: { 'archived-thread': { send } } }),
        };

        await actionPostEmbedNode.run(parseConfig('archived-thread', oneEmbed()), context);
        expect(send).toHaveBeenCalledTimes(1);
    });

    it('builds every part of an embed an author configured, linked pictures included', async () => {
        const send = vi.fn().mockResolvedValue({ id: 'message-1' });

        await actionPostEmbedNode.run(
            parseConfig(CHANNEL_ID, {
                embeds: [
                    {
                        title: 'House Rules',
                        description: 'Read them.',
                        url: 'https://example.com/rules',
                        author: { name: 'The Management', iconUrl: 'https://example.com/boss.png' },
                        image: 'https://example.com/banner.png',
                        thumbnail: 'https://example.com/icon.png',
                        footer: { text: 'Behave yourselves.', iconUrl: 'https://example.com/foot.png' },
                        timestamp: true,
                        fields: [
                            { name: 'Safewords', value: 'Red means stop.', inline: true },
                            { name: 'Consent', value: 'Enthusiastic, or not at all.' },
                        ],
                    },
                ],
            }),
            contextWithChannel(send)
        );

        const payload = send.mock.calls[0]?.[0] as { embeds: EmbedBuilder[] };
        const embed = payload.embeds[0]?.data;

        expect(embed?.url).toBe('https://example.com/rules');
        expect(embed?.author).toEqual({ name: 'The Management', icon_url: 'https://example.com/boss.png' });
        expect(embed?.image?.url).toBe('https://example.com/banner.png');
        expect(embed?.thumbnail?.url).toBe('https://example.com/icon.png');
        expect(embed?.footer).toEqual({ text: 'Behave yourselves.', icon_url: 'https://example.com/foot.png' });
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
            parseConfig(CHANNEL_ID, {
                embeds: [
                    { title: 'First' },
                    {
                        title: 'T',
                        fields: [
                            { name: 'Fine', value: 'Also fine.' },
                            { name: 'Blank', value: '   ' },
                        ],
                    },
                ],
            }),
            contextWithChannel(send)
        );

        expect(outcome).toEqual({
            kind: 'fail',
            // One-based, matching the editor the author is looking at.
            error: expect.stringContaining('"Message" embed 2 field 2'),
        });
        expect(send).not.toHaveBeenCalled();
    });

    /**
     * A part whose whole text was a token that came out empty. The payload builder leaves an
     * empty title off rather than send it, which would leave Discord an embed with nothing in
     * it — refused with a 400 nobody can act on.
     */
    it('fails naming the embed when every part of it rendered to nothing', async () => {
        const send = vi.fn().mockResolvedValue({ id: 'message-1' });
        const rendered: PostEmbedConfig = {
            channelId: CHANNEL_ID,
            message: { embeds: [{ title: '', fields: [], timestamp: false }] },
        };

        const outcome = await actionPostEmbedNode.run(rendered, contextWithChannel(send));

        expect(outcome).toEqual({ kind: 'fail', error: expect.stringMatching(/tokens were filled in.*Embed 1 is empty/) });
        expect(send).not.toHaveBeenCalled();
    });

    /**
     * Parts whose tokens came out as nothing but blank space. Sent as they are, Discord
     * refuses the message with a 400 naming `content` or `embeds.0.title` and nothing an
     * author can act on; left out, the message's own rules say what that leaves.
     */
    it('fails in the product’s words when every part came out as blank space', async () => {
        const send = vi.fn().mockResolvedValue({ id: 'message-1' });
        const rendered: PostEmbedConfig = { channelId: CHANNEL_ID, message: { content: ' \n ', embeds: [] } };

        const outcome = await actionPostEmbedNode.run(rendered, contextWithChannel(send));

        expect(outcome).toEqual({
            kind: 'fail',
            error: "Once its tokens were filled in: This message is empty. Give it some plain text or an embed — Discord won't post nothing.",
        });
        expect(send).not.toHaveBeenCalled();
    });

    it('leaves out a footer whose text came out blank, and says its icon has nothing beside it', async () => {
        const send = vi.fn().mockResolvedValue({ id: 'message-1' });
        const rendered: PostEmbedConfig = {
            channelId: CHANNEL_ID,
            message: {
                embeds: [
                    {
                        title: 'T',
                        footer: { text: '   ', iconUrl: 'https://example.com/foot.png' },
                        fields: [],
                        timestamp: false,
                    },
                ],
            },
        };

        const outcome = await actionPostEmbedNode.run(rendered, contextWithChannel(send));

        expect(outcome).toEqual({ kind: 'fail', error: expect.stringContaining("Embed 1's footer needs some text") });
        expect(send).not.toHaveBeenCalled();
    });

    it('sends text parts trimmed of the blank space their tokens left around them', async () => {
        const send = vi.fn().mockResolvedValue({ id: 'message-1' });
        const rendered: PostEmbedConfig = {
            channelId: CHANNEL_ID,
            message: {
                content: '  Kneel.  ',
                embeds: [{ title: ' Rules ', description: '\nBehave.\n', fields: [], timestamp: false }],
            },
        };

        await actionPostEmbedNode.run(rendered, contextWithChannel(send));

        const payload = send.mock.calls[0]?.[0] as { content: string; embeds: EmbedBuilder[] };
        expect(payload.content).toBe('Kneel.');
        expect(payload.embeds.map((embed) => embed.data)).toEqual([{ title: 'Rules', description: 'Behave.' }]);
    });

    /**
     * The one limit no single field can carry. A save refuses the words an author wrote
     * when they are over on their own; this is the rest — tokens that came out long, which
     * only a run can count. Every part here is comfortably within its own cap, and only
     * the total is over.
     */
    it('fails naming the total when the embeds together came out over Discord 6000 characters', async () => {
        const send = vi.fn().mockResolvedValue({ id: 'message-1' });
        // As rendered: two `{{var.essay}}` bodies that filled in long.
        const rendered: PostEmbedConfig = {
            channelId: CHANNEL_ID,
            message: {
                embeds: [
                    { title: 'T', description: 'd'.repeat(4000), fields: [], timestamp: false },
                    { title: 'U', description: 'd'.repeat(2000), fields: [], timestamp: false },
                ],
            },
        };

        const outcome = await actionPostEmbedNode.run(rendered, contextWithChannel(send));

        expect(outcome).toEqual({
            kind: 'fail',
            error: expect.stringMatching(/tokens were filled in.*6002 characters.*6000/),
        });
        // Nothing is posted: a partially-trimmed embed would read as the flow
        // being broken rather than as the embed being too long.
        expect(send).not.toHaveBeenCalled();
    });
});
