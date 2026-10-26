import { z } from 'zod';
import { RESOURCE_KEY_MAX_LENGTH, RESOURCE_KEY_PATTERN } from '../../../../shared/resourceKey';
import {
    eligibilityConfigSchema,
    ELIGIBILITY_CONFIG_KEY,
    OPEN_GATE,
} from '../../engine/eligibility';
import type { BlockManifest } from '../manifest';

export const TRIGGER_BUTTON_CLICK = 'trigger.buttonClick';

/** A key naming one of the journey's resources, or one of a message's buttons. */
const resourceKeySchema = z
    .string()
    .min(1)
    .max(RESOURCE_KEY_MAX_LENGTH)
    .regex(new RegExp(`^${RESOURCE_KEY_PATTERN}$`));

/**
 * A press on one button of a message this flow's journey declares (step 3,
 * `docs/plans/message-resource-step-3.md`). The trigger owns no button of its own: the
 * message resource defines it, install posts it, and this names it by key.
 *
 * The gate is read **before** the run starts, which is the only place it can be: once the
 * executor is running this block, the press has already been accepted. That is why the gate
 * lives on the trigger's config rather than being something its `run` checks.
 */
export const buttonClickConfigSchema = z.object({
    /**
     * Which button, as bare keys in the flow's own journey — a message resource's key and
     * one of its buttons' keys. One object under one control (`messageButton`), the
     * `eligibility` precedent. No snowflake: a press finds its message through the message's
     * binding, so a copy of the id here would only be one more thing to drift.
     */
    button: z.object({ messageKey: resourceKeySchema, buttonKey: resourceKeySchema }),
    [ELIGIBILITY_CONFIG_KEY]: eligibilityConfigSchema,
});

export type ButtonClickConfig = z.infer<typeof buttonClickConfigSchema>;

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
            key: 'button',
            label: 'Button',
            description: "Which button on which of this journey's messages starts the run.",
            control: 'messageButton',
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
        { key: 'button', emptyText: 'no button picked', stopIfEmpty: true },
        // Only when there is a gate: an open one resolves to empty, which
        // `hideWhenEmpty` drops rather than writing "· Anyone" on every card.
        { key: ELIGIBILITY_CONFIG_KEY, prefix: ' · 🔒 ', hideWhenEmpty: true },
    ],
    handles: [{ label: 'Then', tone: 'neutral' }],
    outputs: [],
    requires: ['subject', 'actor', 'channel', 'interaction'],
    capabilities: [],
    emits: [],
    startedBy: 'buttonClick',
    canSuspend: false,
    run() {
        return { kind: 'continue' };
    },
};
