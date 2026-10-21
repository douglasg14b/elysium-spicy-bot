import { z } from 'zod';
import type { BlockManifest } from '../manifest';
import { requireChannelInGuild } from '../channelInGuild';

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
    emits: [],
    canSuspend: false,
    async run(config, context) {
        // This guild's channels only — see `requireChannelInGuild` for why never the
        // client's. Throws for one that is not sendable here.
        const channel = await requireChannelInGuild(context.guild, config.channelId);
        // Mentions are pinned to users only. Copy is a template now, so a member's
        // own display name reaches this string — and a member called "@everyone"
        // would otherwise make any flow saying `{{subject.username}}` ping the
        // whole guild with the bot's permissions. `users` keeps `{{subject.mention}}`
        // working, which is the point of it.
        await channel.send({ content: config.message, allowedMentions: { parse: ['users'] } });
        return { kind: 'continue' };
    },
};
