import { z } from 'zod';
import type { ActionNodeDefinition } from './types';

export const ACTION_SEND_DM = 'action.sendDM';

export const sendDMConfigSchema = z.object({
    message: z.string().min(1).max(2000),
});

export type SendDMConfig = z.infer<typeof sendDMConfigSchema>;

export const actionSendDMNode: ActionNodeDefinition<SendDMConfig> = {
    type: ACTION_SEND_DM,
    kind: 'action',
    label: 'Send DM',
    configSchema: sendDMConfigSchema,
    async execute(config, context) {
        await context.user.send(config.message);
    },
};
