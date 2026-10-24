import { z } from 'zod';
import { messageConfigSchema } from '../../../../../../../shared/discordMessage';
import type { BlockManifest } from '../../../../../blocks/manifest';

/**
 * A block whose `message` field only sometimes applies — so a test can prove a picture a
 * hidden message field still holds counts as a use of its upload.
 */
export const FIXTURE_ACTION_SOMETIMES_POSTS_MESSAGE = 'fixture.actionSometimesPostsMessage';

export const actionSometimesPostsMessageConfigSchema = z.object({
    mode: z.enum(['quiet', 'post']).default('quiet'),
    // Optional, as the contract requires of a field that can be hidden.
    message: messageConfigSchema.optional(),
});

export type ActionSometimesPostsMessageConfig = z.infer<typeof actionSometimesPostsMessageConfigSchema>;

export const block: BlockManifest<ActionSometimesPostsMessageConfig> = {
    type: FIXTURE_ACTION_SOMETIMES_POSTS_MESSAGE,
    kind: 'action',
    label: 'Sometimes Posts',
    description: 'Holds a message only one of its modes shows. Test fixture, not for a palette.',
    group: 'actions',
    icon: '🫣',
    configSchema: actionSometimesPostsMessageConfigSchema,
    configFields: [
        {
            key: 'mode',
            label: 'Mode',
            control: 'segmented',
            defaultValue: 'quiet',
            options: [
                { value: 'quiet', label: 'Quiet' },
                { value: 'post', label: 'Post' },
            ],
        },
        { key: 'message', label: 'Message', control: 'message', visibleWhen: { field: 'mode', equals: ['post'] } },
    ],
    handles: [{ label: 'Then', tone: 'neutral' }],
    outputs: [],
    requires: [],
    capabilities: [],
    emits: [],
    canSuspend: false,
    run() {
        return { kind: 'continue' };
    },
};
