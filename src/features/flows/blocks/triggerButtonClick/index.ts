import { ButtonStyle } from 'discord.js';
import { z } from 'zod';
import type { BlockManifest } from '../manifest';

export const TRIGGER_BUTTON_CLICK = 'trigger.buttonClick';

/**
 * A button rendered in a Discord channel. Its custom_id is
 * `flow:<flowId>:<nodeId>`, dispatched to the executor by the `flow:` prefix
 * handler registered in initFlows.
 */
export const buttonClickConfigSchema = z.object({
    label: z.string().min(1).max(80),
    /** Discord button style; defaults to Primary when omitted. */
    style: z
        .enum(['Primary', 'Secondary', 'Success', 'Danger'])
        .default('Primary'),
});

export type ButtonClickConfig = z.infer<typeof buttonClickConfigSchema>;

export const BUTTON_STYLE_MAP: Record<ButtonClickConfig['style'], ButtonStyle> = {
    Primary: ButtonStyle.Primary,
    Secondary: ButtonStyle.Secondary,
    Success: ButtonStyle.Success,
    Danger: ButtonStyle.Danger,
};

export const block: BlockManifest<ButtonClickConfig> = {
    type: TRIGGER_BUTTON_CLICK,
    kind: 'trigger',
    label: 'Button Click',
    description: 'Someone presses a button you put in a channel. The usual way in.',
    group: 'triggers',
    icon: '🔘',
    configSchema: buttonClickConfigSchema,
    configFields: [
        {
            key: 'label',
            label: 'Button text',
            description: 'What the button says. Keep it short and inviting.',
            control: 'text',
            maxLength: 80,
        },
        {
            key: 'style',
            label: 'Style',
            control: 'segmented',
            // Matches the schema's own `.default('Primary')` — conformance holds
            // the two together rather than letting them drift apart.
            defaultValue: 'Primary',
            options: [
                { value: 'Primary', label: 'Primary' },
                { value: 'Secondary', label: 'Secondary' },
                { value: 'Success', label: 'Success' },
                { value: 'Danger', label: 'Danger' },
            ],
        },
    ],
    handles: [{ label: 'Then', tone: 'neutral' }],
    outputs: [],
    requires: ['member', 'interaction'],
    capabilities: [],
    startedBy: 'buttonClick',
    canSuspend: false,
    run() {
        return { kind: 'continue' };
    },
};
