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
            rendersTokens: true,
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
        // Mentions are pinned to users only. Copy is a template now, so a member's
        // own display name reaches this string — and a member called "@everyone"
        // would otherwise make any flow saying `{{subject.username}}` ping the
        // whole guild with the bot's permissions. `users` keeps `{{subject.mention}}`
        // working, which is the point of it.
        await channel.send({ content: config.message, allowedMentions: { parse: ['users'] } });
        return { kind: 'continue' };
    },
};
