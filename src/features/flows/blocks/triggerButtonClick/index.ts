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
    description: 'Start the run when someone clicks your button. The classic rules-gate opener.',
    group: 'triggers',
    icon: '🔘',
    configSchema: buttonClickConfigSchema,
    configFields: [
        {
            key: 'label',
            label: 'Button label',
            description: 'What the button says. 1–80 characters — keep it short and inviting.',
            control: 'text',
            placeholder: 'Agree to rules',
            maxLength: 80,
            defaultValue: 'Click me',
        },
        {
            key: 'style',
            label: 'Button style',
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
    cardSummary: [
        {
            key: 'label',
            quote: true,
            truncate: 24,
            emptyText: 'Unlabelled button',
            stopIfEmpty: true,
        },
        { key: 'style', prefix: ' · ' },
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
