import { z } from 'zod';
import type { TriggerNodeDefinition } from './types';

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

export const triggerReactionAddNode: TriggerNodeDefinition<ReactionAddConfig> = {
    type: TRIGGER_REACTION_ADD,
    kind: 'trigger',
    label: 'Reaction Added',
    configSchema: reactionAddConfigSchema,
};
