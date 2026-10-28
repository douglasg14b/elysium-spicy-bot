import { z } from 'zod';
import { messageConfigSchema, trimMessageText } from '../../../../shared/discordMessage';
import { messageButtonsConfigSchema } from '../../../provisioning/logic/messageButtonSchema';
import { recordPostedMessage } from '../../logic/recordPostedMessage';
import type { BlockManifest } from '../manifest';
import { requireChannelInGuild } from '../channelInGuild';
import { messageWithButtons, renderedMessageIssue } from '../messageWithButtons';

export const ACTION_POST_EMBED = 'action.postEmbed';

/** The message field's label: what the form shows, and what every failure names a part by. */
const MESSAGE_LABEL = 'Message';

/**
 * Where to post, the whole message — plain text above, up to ten embeds under it — and the
 * buttons under that.
 *
 * The message is one key holding one object (`src/shared/discordMessage`), edited by the
 * `message` control. Graphs saved when this block held flat keys (`title`, `imageUrl`, …)
 * were rewritten once by `2026-10-24-Post_Embed_Message_Shape`; this schema reads only the
 * new shape.
 *
 * `buttons` is the message field's `buttonsKey`: drawn and edited in the message window, and
 * optional — absent or empty posts none — so every node saved before buttons existed parses.
 */
export const postEmbedConfigSchema = z.object({
    channelId: z.string().min(1),
    message: messageConfigSchema,
    buttons: messageButtonsConfigSchema.optional(),
});

export type PostEmbedConfig = z.infer<typeof postEmbedConfigSchema>;

export const block: BlockManifest<PostEmbedConfig> = {
    type: ACTION_POST_EMBED,
    kind: 'action',
    label: 'Post Embed',
    description: 'Post something that looks like you meant it — words up top, embeds, pictures, buttons, the works.',
    group: 'actions',
    icon: '🖼️',
    configSchema: postEmbedConfigSchema,
    configFields: [
        {
            key: 'channelId',
            label: 'Channel',
            description: 'Where the message gets posted.',
            control: 'channelPicker',
        },
        {
            key: 'message',
            label: MESSAGE_LABEL,
            description: 'Some plain text, up to ten embeds under it, or both — and buttons, if you like. Click a part to dress it up.',
            control: 'message',
            swatches: ['#00A2FF', '#FF2D95', '#7A5CFF', '#FF6B35'],
            buttonsKey: 'buttons',
        },
    ],
    cardSummary: [
        { key: 'channelId', emptyText: 'no channel picked' },
        { key: 'message', prefix: ' · ', quote: true, truncate: 20, hideWhenEmpty: true },
    ],
    handles: [{ label: 'Then', tone: 'neutral' }],
    outputs: [],
    requires: [],
    capabilities: ['sendMessages', 'embedLinks', 'attachFiles'],
    emits: [],
    canSuspend: false,
    async run(config, context) {
        /*
         * Cheapest first. The message as rendered is judged before anything is read — a
         * message that can never post costs no lookup at all. Then the channel, which is
         * nearly always the guild's cache, so a channel deleted since the save fails before
         * any upload is read. Then the uploads: their sizes, judged, and their bytes last.
         */
        const message = trimMessageText(config.message);
        const issue = renderedMessageIssue(message, MESSAGE_LABEL);
        if (issue) {
            return { kind: 'fail', error: issue };
        }

        // This guild's channels only, and thrown for one that is not sendable here —
        // see `requireChannelInGuild`.
        const channel = await requireChannelInGuild(context.guild, config.channelId);

        const buttons = config.buttons ?? [];
        const ready = await messageWithButtons(context.guild, message, buttons, MESSAGE_LABEL);
        if (ready.kind === 'fail') {
            return { kind: 'fail', error: ready.error };
        }

        const posted = await channel.send(ready.options);
        await recordPostedMessage({ posted, buttons, context });
        return { kind: 'continue' };
    },
};
