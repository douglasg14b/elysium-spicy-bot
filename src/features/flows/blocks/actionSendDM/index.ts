import { z } from 'zod';
import type { BlockManifest } from '../manifest';

export const ACTION_SEND_DM = 'action.sendDM';

export const sendDMConfigSchema = z.object({
    message: z.string().min(1).max(2000),
});

export type SendDMConfig = z.infer<typeof sendDMConfigSchema>;

export const block: BlockManifest<SendDMConfig> = {
    type: ACTION_SEND_DM,
    kind: 'action',
    label: 'Send DM',
    description: 'Slide into their DMs. Privately, just between the two of you.',
    group: 'actions',
    icon: '✉️',
    configSchema: sendDMConfigSchema,
    configFields: [
        {
            key: 'message',
            label: 'Message',
            description: 'What to say. Keep it classy-ish. Their DMs may be closed, which fails the run.',
            control: 'longText',
            placeholder: 'Welcome to Afterdark 😈',
            maxLength: 2000,
        },
    ],
    cardSummary: [
        { key: 'message', quote: true, truncate: 30, emptyText: 'no message yet' },
    ],
    handles: [{ label: 'Then', tone: 'neutral' }],
    outputs: [],
    requires: ['member'],
    capabilities: [],
    canSuspend: false,
    async run(config, context) {
        await context.user.send(config.message);
        return { kind: 'continue' };
    },
};
