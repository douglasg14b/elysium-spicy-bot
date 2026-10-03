import { z } from 'zod';
import type { BlockManifest } from '../../../../../blocks/manifest';

/**
 * A block with fields that only sometimes apply — `visibleWhen`'s proof.
 *
 * One copy field and one channel picker, each shown by a different option of `mode`,
 * because those are the two kinds of field the executor resolves before `run`: a stale
 * `{{var}}` in either would fail a run if a hidden field were still read. A test spies
 * on `run` to see which keys it was handed — a hidden one dropped, not merely left
 * unrendered.
 */
export const FIXTURE_SOMETIMES = 'fixture.sometimes';

/** The message's limit, so a test can store a hidden value over it. */
export const MESSAGE_MAX_LENGTH = 20;

export const sometimesConfigSchema = z.object({
    mode: z.enum(['plain', 'copy', 'channel']).default('plain'),
    // Optional, as the contract requires of a field that can be hidden — and limited,
    // which it allows, since a hidden field is left out before the schema sees it.
    message: z.string().max(MESSAGE_MAX_LENGTH).optional(),
    channelId: z.string().optional(),
});

export type SometimesConfig = z.infer<typeof sometimesConfigSchema>;

export const block: BlockManifest<SometimesConfig> = {
    type: FIXTURE_SOMETIMES,
    kind: 'action',
    label: 'Sometimes',
    description: 'Shows a field only when it applies. Test fixture, not for a palette.',
    group: 'actions',
    icon: '🫥',
    configSchema: sometimesConfigSchema,
    configFields: [
        {
            key: 'mode',
            label: 'Mode',
            control: 'segmented',
            defaultValue: 'plain',
            options: [
                { value: 'plain', label: 'Plain' },
                { value: 'copy', label: 'Copy' },
                { value: 'channel', label: 'Channel' },
            ],
        },
        {
            key: 'message',
            label: 'Message',
            control: 'longText',
            maxLength: MESSAGE_MAX_LENGTH,
            rendersTokens: true,
            visibleWhen: { field: 'mode', equals: ['copy'] },
        },
        {
            key: 'channelId',
            label: 'Channel',
            control: 'channelPicker',
            optional: true,
            visibleWhen: { field: 'mode', equals: ['channel'] },
        },
    ],
    cardSummary: [
        { key: 'mode' },
        { key: 'message', prefix: ' · ', emptyText: 'no message' },
        { key: 'channelId', prefix: ' · ', emptyText: 'no channel' },
    ],
    handles: [{ label: 'Next', tone: 'neutral' }],
    outputs: [],
    requires: [],
    capabilities: [],
    canSuspend: false,
    run() {
        return { kind: 'continue' };
    },
};
