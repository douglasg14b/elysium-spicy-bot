import { ButtonStyle } from 'discord.js';
import { z } from 'zod';
import {
    eligibilityConfigSchema,
    ELIGIBILITY_CONFIG_KEY,
    OPEN_GATE,
} from '../../engine/eligibility';
import type { BlockManifest } from '../manifest';

export const TRIGGER_BUTTON_CLICK = 'trigger.buttonClick';

/**
 * A button rendered in a Discord channel. Its custom_id is
 * `flow:<flowId>:<nodeId>`, dispatched to the executor by the `flow:` prefix
 * handler registered in initFlows.
 *
 * The gate is read by `flowTriggerDispatch` **before** the run starts, which is
 * the only place it can be: once the executor is running this block, the press
 * has already been accepted. That is why the gate lives on the trigger's config
 * rather than being something its `run` checks.
 */
export const buttonClickConfigSchema = z.object({
    label: z.string().min(1).max(80),
    /** Discord button style; defaults to Primary when omitted. */
    style: z
        .enum(['Primary', 'Secondary', 'Success', 'Danger'])
        .default('Primary'),
    [ELIGIBILITY_CONFIG_KEY]: eligibilityConfigSchema,
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
        {
            key: ELIGIBILITY_CONFIG_KEY,
            label: 'Who can press it',
            description:
                'Everyone can see the button. Anybody this turns away is told so quietly, and nothing runs.',
            control: 'eligibility',
            // Matches the schema's own `.default(OPEN_GATE)` — every button
            // deployed before gates existed means exactly this.
            defaultValue: OPEN_GATE,
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
        // Only when there is a gate: an open one resolves to empty, which
        // `hideWhenEmpty` drops rather than writing "· Anyone" on every card.
        { key: ELIGIBILITY_CONFIG_KEY, prefix: ' · 🔒 ', hideWhenEmpty: true },
    ],
    handles: [{ label: 'Then', tone: 'neutral' }],
    outputs: [],
    requires: ['subject', 'actor', 'channel', 'interaction'],
    capabilities: [],
    startedBy: 'buttonClick',
    canSuspend: false,
    run() {
        return { kind: 'continue' };
    },
};
