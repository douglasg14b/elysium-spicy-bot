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
    description: 'Start the run when a particular emoji lands on a particular message.',
    group: 'triggers',
    icon: '💥',
    configSchema: reactionAddConfigSchema,
    configFields: [
        {
            key: 'channelId',
            label: 'Channel',
            description: 'Where the watched message lives.',
            control: 'channelPicker',
        },
        {
            key: 'messageId',
            label: 'Message ID',
            description: 'Right-click the message › Copy Message ID (needs Developer Mode).',
            control: 'text',
            placeholder: '1234567890123456789',
        },
        {
            key: 'emoji',
            label: 'Emoji',
            description: 'The reaction to watch for — a literal emoji, or a custom one’s name or id.',
            control: 'text',
            placeholder: '🌶️',
        },
    ],
    cardSummary: [
        { key: 'emoji', emptyText: '—' },
        { text: ' in ' },
        { key: 'channelId', emptyText: 'no channel picked' },
    ],
    handles: [{ label: 'Then', tone: 'neutral' }],
    outputs: [],
    requires: ['subject', 'actor', 'channel'],
    capabilities: [],
    startedBy: 'reactionAdd',
    canSuspend: false,
    run() {
        return { kind: 'continue' };
    },
};
