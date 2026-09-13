import { z } from 'zod';
import type { BlockManifest } from '../manifest';

export const ACTION_SEND_MESSAGE = 'action.sendMessage';

export const sendMessageConfigSchema = z.object({
    channelId: z.string().min(1),
    message: z.string().min(1).max(2000),
});

export type SendMessageConfig = z.infer<typeof sendMessageConfigSchema>;

export const block: BlockManifest<SendMessageConfig> = {
    type: ACTION_SEND_MESSAGE,
    kind: 'action',
    label: 'Send Message',
    description: 'Say something out loud, in a channel of your choosing.',
    group: 'actions',
    icon: '💬',
    configSchema: sendMessageConfigSchema,
    configFields: [
        {
            key: 'channelId',
            label: 'Channel',
            description: 'Where the message gets posted.',
            control: 'channelPicker',
        },
        {
            key: 'message',
            label: 'Message',
            control: 'longText',
            placeholder: 'Say something spicy…',
            maxLength: 2000,
        },
    ],
    cardSummary: [
        { key: 'channelId', emptyText: 'no channel picked' },
        { key: 'message', prefix: ' · ', quote: true, truncate: 20, hideWhenEmpty: true },
    ],
    handles: [{ label: 'Then', tone: 'neutral' }],
    outputs: [],
    requires: [],
    capabilities: ['sendMessages'],
    canSuspend: false,
    async run(config, context) {
        const channel = await context.client.channels.fetch(config.channelId);
        // Thrown rather than returned as `fail`: a channel that has stopped being
        // sendable is not an expected outcome of this block, it is the world
        // having changed underneath a saved flow. M1 keeps the existing behaviour;
        // giving these a typed failure is a later milestone's taxonomy work.
        if (!channel || !channel.isTextBased() || !('send' in channel)) {
            throw new Error(`Channel ${config.channelId} is not a sendable text channel`);
        }
        await channel.send(config.message);
        return { kind: 'continue' };
    },
};
