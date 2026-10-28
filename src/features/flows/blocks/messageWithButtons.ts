import type { Guild, MessageCreateOptions } from 'discord.js';
import { readMessageUploads } from '../../../features-system/guild-uploads';
import { buildMessagePayload, messageProblems } from '../../../shared/discordMessage';
// Its own `import type`: the engine vocabulary gate reads an inline `type DiscordMessage` as a declaration.
import type { DiscordMessage } from '../../../shared/discordMessage';
import { buildButtonRows, serverEmojiIds, type MessageButton } from '../../provisioning/logic/messageButtons';

/**
 * Posting a block's `message` field, and the buttons under it: the checks a rendered message
 * must pass, its uploads, and what `channel.send` is handed — shared by every block that posts
 * one (Post Embed, and Open Ticket's message above the ticket card), so both judge, attach and
 * button a message the same way.
 *
 * A block calls the two in its own order — {@link renderedMessageIssue} first, since it costs
 * nothing, then whatever it must check before anything is read, then {@link messageWithButtons}
 * — and records a post that carried buttons (`logic/recordPostedMessage.ts`).
 */

/** `"Message" embed 1 image` — a part as a failure names it, by the field's own label. */
function partLabel(fieldLabel: string, where: string): string {
    return `"${fieldLabel}" ${where}`;
}

/**
 * Why the rendered message cannot be posted as it stands, or undefined when it can.
 *
 * Every check here is one the schema could not finish, because it needs the copy as it came
 * out of its tokens — `{{subject.username}}` is 19 characters that become however long a
 * member called themselves, and `{{var.pick}}` might hold nothing at all. Asked of the
 * message after `trimMessageText`, so a part that came out as blank space is already left
 * out. In order:
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
 *
 * @param fieldLabel the `message` field's label, which every failure names a part by.
 */
export function renderedMessageIssue(message: DiscordMessage, fieldLabel: string): string | undefined {
    for (const [embedIndex, embed] of message.embeds.entries()) {
        const emptyField = embed.fields.findIndex((field) => !field.name.trim() || !field.value.trim());
        if (emptyField !== -1) {
            const where = partLabel(fieldLabel, `embed ${embedIndex + 1} field ${emptyField + 1}`);
            return (
                `${where} has an empty heading or text once its tokens are filled in. ` +
                "Discord won't take a field with a blank side — give it literal words, or drop it."
            );
        }
    }

    const [issue] = messageProblems(message);
    if (issue) {
        return `Once its tokens were filled in: ${issue.message}`;
    }

    return undefined;
}

/** What a message comes to once its uploads are read: what to send, or why it cannot go. */
export type MessageWithButtons =
    | { readonly kind: 'ready'; readonly options: MessageCreateOptions }
    | { readonly kind: 'fail'; readonly error: string };

/**
 * A rendered, judged message as `channel.send` takes it: its uploads read for **this guild
 * only** (`readMessageUploads` — a deleted upload, another server's, or too many bytes fail
 * naming the part), its buttons in rows under it, and its mentions pinned to users.
 *
 * The buttons are provisioning's (`buildButtonRows`), pressed by `mbtn:<buttonKey>` — the one
 * handler flows registers for the prefix answers a press. A server emoji gone from the server
 * is left off its button rather than having Discord refuse the whole message. No buttons is no
 * rows.
 *
 * Mentions pinned to users, as Send Message pins them: the plain text is copy, so a member
 * called "@everyone" reaches it through `{{subject.username}}`, and `users` keeps
 * `{{subject.mention}}` pinging the one member it names.
 *
 * @param fieldLabel the `message` field's label, which an upload failure names a part by.
 */
export async function messageWithButtons(
    guild: Guild,
    message: DiscordMessage,
    buttons: readonly MessageButton[],
    fieldLabel: string
): Promise<MessageWithButtons> {
    const read = await readMessageUploads(guild.id, message);
    if (!read.ok) {
        const { problem } = read;
        return { kind: 'fail', error: problem.where ? `${partLabel(fieldLabel, problem.where)}: ${problem.message}` : problem.message };
    }

    return {
        kind: 'ready',
        options: {
            ...buildMessagePayload(message, read.files),
            components: buildButtonRows(buttons, serverEmojiIds(guild)),
            allowedMentions: { parse: ['users'] },
        },
    };
}
