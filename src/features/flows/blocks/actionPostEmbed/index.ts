import { z } from 'zod';
import { readMessageUploads } from '../../../../features-system/guild-uploads';
import {
    buildMessagePayload,
    messageConfigSchema,
    messageProblems,
    trimMessageText,
    type DiscordMessage,
} from '../../../../shared/discordMessage';
import type { BlockManifest } from '../manifest';
import { requireChannelInGuild } from '../channelInGuild';

export const ACTION_POST_EMBED = 'action.postEmbed';

/** The message field's label: what the form shows, and what every failure names a part by. */
const MESSAGE_LABEL = 'Message';

/**
 * Where to post, and the whole message: plain text above, up to ten embeds under it.
 *
 * The message is one key holding one object (`src/shared/discordMessage`), edited by the
 * `message` control. Graphs saved when this block held flat keys (`title`, `imageUrl`, …)
 * were rewritten once by `2026-10-24-Post_Embed_Message_Shape`; this schema reads only the
 * new shape.
 */
export const postEmbedConfigSchema = z.object({
    channelId: z.string().min(1),
    message: messageConfigSchema,
});

export type PostEmbedConfig = z.infer<typeof postEmbedConfigSchema>;

/** `"Message" embed 1 image` — a part as a failure names it. */
function partLabel(where: string): string {
    return `"${MESSAGE_LABEL}" ${where}`;
}

/**
 * Why the rendered message cannot be posted as it stands, or undefined when it can.
 *
 * Every check here is one the schema could not finish, because it needs the copy as it came
 * out of its tokens — `{{subject.username}}` is 19 characters that become however long a
 * member called themselves, and `{{var.pick}}` might hold nothing at all. Asked of the
 * message after {@link trimMessageText}, so a part that came out as blank space is already
 * left out. In order:
 *
 *  1. **No field with a blank side.** Discord refuses one with a 400 naming
 *     `embeds.0.fields.0.name` and nothing an author can act on, and discord.js does not
 *     check it.
 *  2. **The save-time rules again** (`messageProblems`), on the message as rendered: a part
 *     left out can leave an embed — or the whole message — empty, and the embeds' text
 *     together can now be over Discord's 6000 characters. Failing rather than trimming: a
 *     silently cut embed reads as a broken flow rather than as a long one.
 *
 * A picture that was copy is not judged here: the executor refused it while rendering unless
 * it came out as a link (`checkRendered` on its copy location), which is the one place that
 * still knew it was copy.
 */
function renderedMessageProblem(message: DiscordMessage): string | undefined {
    for (const [embedIndex, embed] of message.embeds.entries()) {
        const blankField = embed.fields.findIndex((field) => !field.name.trim() || !field.value.trim());
        if (blankField !== -1) {
            return (
                `${partLabel(`embed ${embedIndex + 1} field ${blankField + 1}`)} has an empty heading or text once its ` +
                "tokens are filled in. Discord won't take a field with a blank side — give it literal words, or drop it."
            );
        }
    }

    const problem = messageProblems(message)[0];
    if (problem) {
        return `Once its tokens were filled in: ${problem.message}`;
    }

    return undefined;
}

export const block: BlockManifest<PostEmbedConfig> = {
    type: ACTION_POST_EMBED,
    kind: 'action',
    label: 'Post Embed',
    description: 'Post something that looks like you meant it — words up top, embeds, pictures, the works.',
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
            description: 'Some plain text, up to ten embeds under it, or both. Click a part to dress it up.',
            control: 'message',
            swatches: ['#00A2FF', '#FF2D95', '#7A5CFF', '#FF6B35'],
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
        const problem = renderedMessageProblem(message);
        if (problem) {
            return { kind: 'fail', error: problem };
        }

        // This guild's channels only, and thrown for one that is not sendable here —
        // see `requireChannelInGuild`.
        const channel = await requireChannelInGuild(context.guild, config.channelId);

        // This guild's uploads only; see `readMessageUploads`.
        const uploads = await readMessageUploads(context.guild.id, message);
        if (!uploads.ok) {
            const { problem } = uploads;
            return { kind: 'fail', error: problem.where ? `${partLabel(problem.where)}: ${problem.message}` : problem.message };
        }

        // Mentions pinned to users, as Send Message pins them: the plain text is copy, so a
        // member called "@everyone" reaches it through `{{subject.username}}`, and `users`
        // keeps `{{subject.mention}}` pinging the one member it names.
        await channel.send({ ...buildMessagePayload(message, uploads.files), allowedMentions: { parse: ['users'] } });
        return { kind: 'continue' };
    },
};
