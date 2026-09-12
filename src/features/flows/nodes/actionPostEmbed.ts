import { EmbedBuilder } from 'discord.js';
import { z } from 'zod';
import type { ActionNodeDefinition } from './types';

export const ACTION_POST_EMBED = 'action.postEmbed';

/** Hex colour like `#00A2FF` (the SpicyBot cyan). Optional — Discord picks a default. */
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

export const actionPostEmbedNode: ActionNodeDefinition<PostEmbedConfig> = {
    type: ACTION_POST_EMBED,
    kind: 'action',
    label: 'Post Embed',
    configSchema: postEmbedConfigSchema,
    async execute(config, context) {
        const channel = await context.client.channels.fetch(config.channelId);
        if (!channel || !channel.isTextBased() || !('send' in channel)) {
            throw new Error(`Channel ${config.channelId} is not a sendable text channel`);
        }

        const embed = new EmbedBuilder().setTitle(config.title).setDescription(config.description);
        if (config.color) {
            embed.setColor(hexColorToInt(config.color));
        }

        await channel.send({ embeds: [embed] });
    },
};
