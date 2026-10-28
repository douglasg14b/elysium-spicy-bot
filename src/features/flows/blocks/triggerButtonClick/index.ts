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
 * A button on a message resource, as bare keys in the flow's own journey — the message's key
 * and one of its buttons' keys. No snowflake: a press finds its message through the message's
 * binding, so a copy of the id here would only be one more thing to drift.
 */
const resourceButtonSchema = z.object({ messageKey: resourceKeySchema, buttonKey: resourceKeySchema });

/**
 * A button under a message a block posts (Post Embed's, Open Ticket's): the flow and node that
 * post it, and the button's key on that node (step 2, `docs/plans/block-message-buttons-step-2.md`).
 * `flowId` is written even when the poster is this flow, so every comparison is an exact
 * triple. A press finds its post through `flow_posted_messages`, never through these ids.
 */
const blockButtonSchema = z.object({
    flowId: z.string().min(1),
    nodeId: z.string().min(1),
    buttonKey: resourceKeySchema,
});

/**
 * A press on one button — of a message this flow's journey declares (step 3,
 * `docs/plans/message-resource-step-3.md`), or of a message a block posts (step 2 of
 * `docs/plans/block-message-buttons-step-2.md`). The trigger owns no button of its own:
 * the message defines it, and this names it.
 *
 * The gate is read **before** the run starts, which is the only place it can be: once the
 * executor is running this block, the press has already been accepted. That is why the gate
 * lives on the trigger's config rather than being something its `run` checks.
 */
export const buttonClickConfigSchema = z.object({
    /**
     * Which button. One object under one control (`messageButton`), the `eligibility`
     * precedent. A plain union, no discriminator: every graph saved before block buttons
     * matches the first arm as it stands, so none needed rewriting.
     */
    button: z.union([resourceButtonSchema, blockButtonSchema]),
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
            description: "Which button starts the run — on one of this journey's messages, or under a block's post.",
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
