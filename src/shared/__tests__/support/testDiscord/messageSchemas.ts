import { ButtonStyle, ComponentType } from 'discord.js';
import { z } from 'zod';

/**
 * The message bodies discord.js 14 puts on the wire, parsed as strictly as the channel
 * routes parse theirs.
 *
 * Narrower than what Discord accepts, on purpose: embeds carry only the members an
 * `EmbedBuilder` has been seen to send here (Post Embed's every part, author `url` aside), and components only action rows of
 * custom-id buttons. A new member in the product's output is a new behaviour to model,
 * and a strict schema is what makes it announce itself instead of being stored and
 * forgotten.
 *
 * `tts` and `enforce_nonce` are literal `false` because discord.js always sends both,
 * and a message that asked for text-to-speech or a nonce would need behaviour the
 * harness does not have.
 */

const snowflake = z.string().regex(/^\d{17,20}$/);

/**
 * A picture or link on an embed, as `EmbedBuilder` sends it: a plain string, which may be an
 * `attachment://<name>` naming a file the same request uploads. Which names are allowed is
 * the message's to check, against its files (`ServerMessages.checkSend`).
 */
const embedLink = z.string().min(1);

const embedSchema = z.strictObject({
    title: z.string().max(256).optional(),
    description: z.string().max(4096).optional(),
    url: embedLink.optional(),
    color: z.number().int().min(0).max(0xffffff).optional(),
    timestamp: z.iso.datetime().optional(),
    author: z.strictObject({ name: z.string().max(256), icon_url: embedLink.optional() }).optional(),
    thumbnail: z.strictObject({ url: embedLink }).optional(),
    image: z.strictObject({ url: embedLink }).optional(),
    footer: z.strictObject({ text: z.string().max(2048), icon_url: embedLink.optional() }).optional(),
    fields: z
        .array(
            z.strictObject({
                name: z.string().max(256),
                value: z.string().max(1024),
                inline: z.boolean().optional(),
            })
        )
        .max(25)
        .optional(),
});

/** Link and premium buttons carry a url or a sku instead of a custom id, and are not modelled. */
const buttonSchema = z.strictObject({
    type: z.literal(ComponentType.Button),
    style: z.union([
        z.literal(ButtonStyle.Primary),
        z.literal(ButtonStyle.Secondary),
        z.literal(ButtonStyle.Success),
        z.literal(ButtonStyle.Danger),
    ]),
    custom_id: z.string().min(1).max(100),
    label: z.string().max(80).optional(),
    emoji: z
        .strictObject({ name: z.string().min(1), id: snowflake.optional(), animated: z.boolean().optional() })
        .optional(),
    disabled: z.boolean().optional(),
});

const actionRowSchema = z.strictObject({
    type: z.literal(ComponentType.ActionRow),
    components: z.array(buttonSchema).min(1).max(5),
});

/**
 * Only the `parse` form. The explicit `users`/`roles` lists change which mentions Discord
 * resolves, and nothing here has needed them. `replied_user` is accepted because the bot's
 * client default (`discordClient.ts`) sends it on every message; it only means anything on
 * a reply, and a reference is not modelled here, so it changes nothing.
 */
const allowedMentionsSchema = z.strictObject({
    parse: z.array(z.enum(['users', 'roles', 'everyone'])),
    replied_user: z.boolean().optional(),
});

/**
 * A message create. With files, discord.js sends it multipart — this as `payload_json`, each
 * file as `files[n]` — and lists one `attachments` entry per file, its `id` the file's index.
 * It sends no `description` unless one was given, and nothing here gives one.
 */
export const createMessageSchema = z.strictObject({
    content: z.string().max(2000).optional(),
    tts: z.literal(false),
    enforce_nonce: z.literal(false),
    embeds: z.array(embedSchema).max(10).optional(),
    components: z.array(actionRowSchema).max(5).optional(),
    allowed_mentions: allowedMentionsSchema.optional(),
    attachments: z
        .array(z.strictObject({ id: z.string().regex(/^\d+$/) }))
        .max(10)
        .optional(),
});

/**
 * An edit. Absent members are left alone and present ones replace, exactly as Discord's
 * PATCH treats them. `allowed_mentions` arrives when the client has a default — discord.js
 * sends it on an edit of the bot's own message — as `DISCORD_CLIENT` does; the harness's own
 * client sets none.
 */
export const editMessageSchema = z.strictObject({
    content: z.string().max(2000).optional(),
    tts: z.literal(false),
    enforce_nonce: z.literal(false),
    embeds: z.array(embedSchema).max(10).optional(),
    components: z.array(actionRowSchema).max(5).optional(),
    allowed_mentions: allowedMentionsSchema.optional(),
});

export type CreateMessageBody = z.infer<typeof createMessageSchema>;
export type EditMessageBody = z.infer<typeof editMessageSchema>;
