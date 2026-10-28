import { z } from 'zod';
import type { BlockManifest } from '../manifest';
import {
    CHANNEL_CHOICE_CARD_PART,
    CHANNEL_CHOICE_FIELD,
    CHANNEL_PICKER_FIELD,
    channelChoiceShape,
    channelFor,
    checkChannelChoice,
} from '../channelChoice';

export const ACTION_SEND_MESSAGE = 'action.sendMessage';

/**
 * Where to post — the shared channel choice (`blocks/channelChoice.ts`): a picked channel, the
 * default every node saved before the choice means, or the channel the run happened in — and
 * what to say.
 */
export const sendMessageConfigSchema = z
    .object({
        ...channelChoiceShape,
        message: z.string().min(1).max(2000),
    })
    .superRefine((config, context) => checkChannelChoice(config, context));

export type SendMessageConfig = z.infer<typeof sendMessageConfigSchema>;

export const block: BlockManifest<SendMessageConfig> = {
    type: ACTION_SEND_MESSAGE,
    kind: 'action',
    label: 'Send Message',
    description: 'Say something out loud — right where it happened, or in a channel of your choosing.',
    group: 'actions',
    icon: '💬',
    configSchema: sendMessageConfigSchema,
    configFields: [
        CHANNEL_CHOICE_FIELD,
        CHANNEL_PICKER_FIELD,
        {
            key: 'message',
            label: 'Message',
            control: 'longText',
            placeholder: 'Say something spicy…',
            maxLength: 2000,
            rendersTokens: true,
        },
    ],
    // "#general · "Say something…"", or "The channel this happened in · …" — the hidden
    // picker's part renders nothing, so only one of the first two ever shows.
    cardSummary: [
        CHANNEL_CHOICE_CARD_PART,
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
        // The picked channel or the run's own, this guild's only — see `channelFor` and
        // `requireChannelInGuild` for why never the client's. Throws for one that is not
        // sendable here.
        const channel = await channelFor(context, config);
        // Mentions are pinned to users only. Copy is a template now, so a member's
        // own display name reaches this string — and a member called "@everyone"
        // would otherwise make any flow saying `{{subject.username}}` ping the
        // whole guild with the bot's permissions. `users` keeps `{{subject.mention}}`
        // working, which is the point of it.
        await channel.send({ content: config.message, allowedMentions: { parse: ['users'] } });
        return { kind: 'continue' };
    },
};
