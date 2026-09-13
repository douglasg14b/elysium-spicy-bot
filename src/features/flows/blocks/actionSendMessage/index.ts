import { z } from 'zod';
import type { ActionNodeDefinition } from '../types';

export const ACTION_SEND_MESSAGE = 'action.sendMessage';

export const sendMessageConfigSchema = z.object({
    channelId: z.string().min(1),
    message: z.string().min(1).max(2000),
});

export type SendMessageConfig = z.infer<typeof sendMessageConfigSchema>;

export const block: ActionNodeDefinition<SendMessageConfig> = {
    type: ACTION_SEND_MESSAGE,
    kind: 'action',
    label: 'Send Message',
    configSchema: sendMessageConfigSchema,
    async execute(config, context) {
        const channel = await context.client.channels.fetch(config.channelId);
        if (!channel || !channel.isTextBased() || !('send' in channel)) {
            throw new Error(`Channel ${config.channelId} is not a sendable text channel`);
        }
        await channel.send(config.message);
    },
};
