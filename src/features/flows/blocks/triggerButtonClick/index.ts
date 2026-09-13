import { ButtonStyle } from 'discord.js';
import { z } from 'zod';
import type { TriggerNodeDefinition } from '../types';

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

export const block: TriggerNodeDefinition<ButtonClickConfig> = {
    type: TRIGGER_BUTTON_CLICK,
    kind: 'trigger',
    label: 'Button Click',
    configSchema: buttonClickConfigSchema,
};
