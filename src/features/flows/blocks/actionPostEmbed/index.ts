import { EmbedBuilder } from 'discord.js';
import { z } from 'zod';
import type { BlockManifest } from '../manifest';

export const ACTION_POST_EMBED = 'action.postEmbed';

/**
 * Hex colour like `#00A2FF` (the SpicyBot cyan).
 *
 * **Stays optional.** A newly dropped node is seeded with the brand cyan by the
 * field's `defaultValue`, so an author who never opens the colour picker still
 * gets the product's own colour rather than Discord's grey. But absence remains
 * valid and must: every graph saved before that default existed carries no
 * `color`, as does anything written straight through the API, and `run` still
 * guards with `if (config.color)`. Removing `.optional()` to match the default
 * would make those existing rows unparseable.
 */
const hexColorSchema = z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, 'Colour must be a hex value like #00A2FF');

export const postEmbedConfigSchema = z.object({
    channelId: z.string().min(1),
    title: z.string().min(1).max(256),
    description: z.string().min(1).max(4096),
    color: hexColorSchema.optional(),
});

export type PostEmbedConfig = z.infer<typeof postEmbedConfigSchema>;

/** `#00A2FF` -> 0x00A2FF, the integer form discord.js embeds want. */
export function hexColorToInt(hex: string): number {
    return Number.parseInt(hex.slice(1), 16);
}

export const block: BlockManifest<PostEmbedConfig> = {
    type: ACTION_POST_EMBED,
    kind: 'action',
    label: 'Post Embed',
    description: 'Post something that looks like you meant it — title, blurb, and a colour stripe.',
    group: 'actions',
    icon: '🖼️',
    configSchema: postEmbedConfigSchema,
    configFields: [
        {
            key: 'channelId',
            label: 'Channel',
            description: 'Where the embed gets posted.',
            control: 'channelPicker',
        },
        {
            key: 'title',
            label: 'Title',
            control: 'text',
            placeholder: 'House Rules',
            maxLength: 256,
        },
        {
            key: 'description',
            label: 'Body',
            control: 'longText',
            placeholder: 'The fine print nobody reads…',
            maxLength: 4096,
        },
        {
            key: 'color',
            label: 'Accent colour',
            description: 'The stripe down the side of the embed.',
            control: 'colour',
            defaultValue: '#00A2FF',
            swatches: ['#00A2FF', '#FF2D95', '#7A5CFF', '#FF6B35'],
        },
    ],
    handles: [{ label: 'Then', tone: 'neutral' }],
    outputs: [],
    requires: [],
    capabilities: ['sendMessages', 'embedLinks'],
    canSuspend: false,
    async run(config, context) {
        const channel = await context.client.channels.fetch(config.channelId);
        // Thrown rather than returned as `fail` — see the note on `action.sendMessage`.
        if (!channel || !channel.isTextBased() || !('send' in channel)) {
            throw new Error(`Channel ${config.channelId} is not a sendable text channel`);
        }

        const embed = new EmbedBuilder().setTitle(config.title).setDescription(config.description);
        if (config.color) {
            embed.setColor(hexColorToInt(config.color));
        }

        await channel.send({ embeds: [embed] });
        return { kind: 'continue' };
    },
};
