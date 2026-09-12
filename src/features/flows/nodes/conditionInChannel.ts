import { z } from 'zod';
import type { ConditionNodeDefinition } from './types';

export const CONDITION_IN_CHANNEL = 'condition.inChannel';

export const inChannelConfigSchema = z.object({
    channelId: z.string().min(1),
});

export type InChannelConfig = z.infer<typeof inChannelConfigSchema>;

export const conditionInChannelNode: ConditionNodeDefinition<InChannelConfig> = {
    type: CONDITION_IN_CHANNEL,
    kind: 'condition',
    label: 'In Channel?',
    configSchema: inChannelConfigSchema,
    evaluate(config, context) {
        // Only interaction-originated runs know "where" they happened; a gateway
        // trigger (member join) has no channel, so it takes the false branch.
        const channelId = context.interaction?.channelId;
        return channelId === config.channelId ? 'true' : 'false';
    },
};
