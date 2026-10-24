import { z } from 'zod';
import { messageConfigSchema } from '../../../../../../../shared/discordMessage';
import type { BlockManifest } from '../../../../../blocks/manifest';

/**
 * A block holding a whole message in one `message` field — so a test can prove the copy
 * walk reaches inside it, at save and at run, before any shipped block holds one.
 *
 * Its `run` posts the first field's text of the second embed, which is where the test
 * puts its token, so what was rendered is what reaches the channel.
 */
export const FIXTURE_ACTION_POSTS_MESSAGE = 'fixture.actionPostsMessage';

export const actionPostsMessageConfigSchema = z.object({ message: messageConfigSchema });

export type ActionPostsMessageConfig = z.infer<typeof actionPostsMessageConfigSchema>;

export const block: BlockManifest<ActionPostsMessageConfig> = {
    type: FIXTURE_ACTION_POSTS_MESSAGE,
    kind: 'action',
    label: 'Posts Message',
    description: 'Posts one part of a message it holds. Test fixture, not for a palette.',
    group: 'actions',
    icon: '💌',
    configSchema: actionPostsMessageConfigSchema,
    configFields: [{ key: 'message', label: 'Message', control: 'message' }],
    handles: [{ label: 'Then', tone: 'neutral' }],
    outputs: [],
    requires: ['channel'],
    capabilities: ['sendMessages'],
    emits: [],
    canSuspend: false,
    async run(config, context) {
        const text = config.message.embeds[1]?.fields[0]?.value;
        if (!context.channel || !text) {
            return { kind: 'fail', error: 'Nowhere to post, or nothing in embed 2 field 1 to post.' };
        }
        await context.channel.send({ content: text, allowedMentions: { parse: ['users'] } });
        return { kind: 'continue' };
    },
};
