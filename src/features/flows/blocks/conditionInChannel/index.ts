import { z } from 'zod';
import type { BlockManifest } from '../manifest';
import type { FlowRunContext } from '../types';

export const CONDITION_IN_CHANNEL = 'condition.inChannel';

export const inChannelConfigSchema = z.object({
    channelId: z.string().min(1),
});

export type InChannelConfig = z.infer<typeof inChannelConfigSchema>;

export const block: BlockManifest<InChannelConfig> = {
    type: CONDITION_IN_CHANNEL,
    kind: 'condition',
    label: 'In Channel?',
    description: 'Split the path on where the run started.',
    group: 'conditions',
    icon: '📍',
    configSchema: inChannelConfigSchema,
    configFields: [
        {
            key: 'channelId',
            label: 'Channel to check',
            description:
                'The channel the run must have started in — a thread under it counts. Leave by Yes when it did.',
            control: 'channelPicker',
        },
    ],
    cardSummary: [
        { key: 'channelId', prefix: 'Is it ', suffix: '?', emptyText: 'no channel picked' },
    ],
    handles: [
        { id: 'true', label: 'Yes', tone: 'positive' },
        { id: 'false', label: 'No', tone: 'negative' },
    ],
    outputs: [],
    // Declared rather than merely documented: a run with no channel cannot answer
    // this question, and save-time validation says so before it runs.
    requires: ['channel'],
    capabilities: [],
    canSuspend: false,
    run(config, context) {
        // The run's own channel, not the originating interaction's. Reading the
        // interaction meant this silently answered "no" on every resumed run —
        // the interaction is gone once a run parks, so a flow that asked where it
        // was after a wait always took the false branch regardless of the truth.
        // A run that genuinely has no channel still takes false, which is the one
        // honest answer to "are you in #x" when you are nowhere.
        return { kind: 'continue', handle: isInChannel(context.channel, config.channelId) ? 'true' : 'false' };
    },
};

/**
 * Whether the run is in the channel, or in a thread under it.
 *
 * A thread counts toward its channel everywhere a flow asks about a place — Message
 * Sent, the message wait, quiet timeouts — so a run Message Sent started for a thread
 * reply under #general answers Yes to "is it #general", as its own trigger did.
 */
function isInChannel(channel: FlowRunContext['channel'], channelId: string): boolean {
    if (!channel) return false;
    return channel.id === channelId || (channel.isThread() && channel.parentId === channelId);
}
