import { z } from 'zod';
import type { BlockManifest } from '../manifest';

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
            description: 'The channel the run must have started in. Leave by Yes when it did.',
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
    // Declared rather than merely documented: a run with no interaction cannot
    // answer this question, and save-time validation says so before it runs.
    requires: ['interaction'],
    capabilities: [],
    canSuspend: false,
    run(config, context) {
        // Only interaction-originated runs know "where" they happened; a gateway
        // trigger (member join) has no channel, so it takes the false branch.
        const channelId = context.interaction?.channelId;
        return { kind: 'continue', handle: channelId === config.channelId ? 'true' : 'false' };
    },
};
