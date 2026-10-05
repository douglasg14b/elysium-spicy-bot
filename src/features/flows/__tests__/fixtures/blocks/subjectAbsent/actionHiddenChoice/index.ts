import { z } from 'zod';
import type { BlockManifest } from '../../../../../blocks/manifest';

/**
 * A block whose member-needing choice and member-mentioning copy are both hidden until
 * `mode` is `detailed` — so a test can prove that a hidden field's option requirement and
 * a hidden field's tokens are ignored, and that showing them makes them count. No shipped
 * block has a hidden choice carrying `requires`, which is why this exists.
 */
export const FIXTURE_ACTION_HIDDEN_CHOICE = 'fixture.actionHiddenChoice';

export const actionHiddenChoiceConfigSchema = z.object({
    mode: z.enum(['plain', 'detailed']).default('plain'),
    who: z.enum(['member', 'anyone']).optional(),
    note: z.string().optional(),
});

export type ActionHiddenChoiceConfig = z.infer<typeof actionHiddenChoiceConfigSchema>;

export const block: BlockManifest<ActionHiddenChoiceConfig> = {
    type: FIXTURE_ACTION_HIDDEN_CHOICE,
    kind: 'action',
    label: 'Hidden Choice',
    description: 'Hides its member choice and copy until asked. Test fixture, not for a palette.',
    group: 'actions',
    icon: '🙈',
    configSchema: actionHiddenChoiceConfigSchema,
    configFields: [
        {
            key: 'mode',
            label: 'Mode',
            control: 'segmented',
            defaultValue: 'plain',
            options: [
                { value: 'plain', label: 'Plain' },
                { value: 'detailed', label: 'Detailed' },
            ],
        },
        {
            key: 'who',
            label: 'Who',
            control: 'select',
            visibleWhen: { field: 'mode', equals: ['detailed'] },
            options: [
                { value: 'member', label: 'The member', requires: ['subject'] },
                { value: 'anyone', label: 'Anyone' },
            ],
        },
        {
            key: 'note',
            label: 'Note',
            control: 'longText',
            rendersTokens: true,
            visibleWhen: { field: 'mode', equals: ['detailed'] },
        },
    ],
    handles: [{ label: 'Then', tone: 'neutral' }],
    outputs: [],
    requires: [],
    capabilities: [],
    canSuspend: false,
    run() {
        return { kind: 'continue' };
    },
};
