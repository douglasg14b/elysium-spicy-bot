import { z } from 'zod';
import type { BlockManifest } from '../manifest';

export const TRIGGER_REACTION_ADD = 'trigger.reactionAdd';

/**
 * Fires when a specific emoji is added to a specific message. Dispatched by the
 * `MessageReactionAdd` gateway listener registered in initFlows.
 *
 * `emoji` matches either a unicode emoji ("🌶️") or a custom emoji's name or id —
 * see {@link reactionMatchesEmoji} in the dispatcher.
 */
export const reactionAddConfigSchema = z.object({
    channelId: z.string().min(1),
    messageId: z.string().min(1),
    emoji: z.string().min(1),
});

export type ReactionAddConfig = z.infer<typeof reactionAddConfigSchema>;

export const block: BlockManifest<ReactionAddConfig> = {
    type: TRIGGER_REACTION_ADD,
    kind: 'trigger',
    label: 'Reaction Added',
    description: 'Someone reacts to a particular message with a particular emoji.',
    group: 'triggers',
    icon: '💥',
    configSchema: reactionAddConfigSchema,
    configFields: [
        {
            key: 'channelId',
            label: 'Channel',
            description: 'Where the message lives.',
            control: 'channelPicker',
        },
        {
            key: 'messageId',
            label: 'Message ID',
            description: 'Right-click the message and Copy Message ID.',
            control: 'text',
        },
        {
            key: 'emoji',
            label: 'Emoji',
            description: 'The emoji itself, or a custom emoji’s name or id.',
            control: 'text',
        },
    ],
    handles: [{ label: 'Then', tone: 'neutral' }],
    outputs: [],
    requires: ['member'],
    capabilities: [],
    startedBy: 'reactionAdd',
    canSuspend: false,
    run() {
        return { kind: 'continue' };
    },
};
