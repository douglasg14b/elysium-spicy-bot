import { ButtonStyle, ComponentType } from 'discord.js';
import { z } from 'zod';

/**
 * The message bodies discord.js 14 puts on the wire, parsed as strictly as the channel
 * routes parse theirs.
 *
 * Narrower than what Discord accepts, on purpose: embeds carry only the members an
 * `EmbedBuilder` has been seen to send here, and components only action rows of
 * custom-id buttons. A new member in the product's output is a new behaviour to model,
 * and a strict schema is what makes it announce itself instead of being stored and
 * forgotten.
 *
 * `tts` and `enforce_nonce` are literal `false` because discord.js always sends both,
 * and a message that asked for text-to-speech or a nonce would need behaviour the
 * harness does not have.
 */

const snowflake = z.string().regex(/^\d{17,20}$/);

const embedSchema = z.strictObject({
    title: z.string().max(256).optional(),
    description: z.string().max(4096).optional(),
    color: z.number().int().min(0).max(0xffffff).optional(),
    timestamp: z.iso.datetime().optional(),
    footer: z.strictObject({ text: z.string().max(2048) }).optional(),
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
 * Only the `parse` form. The explicit `users`/`roles` lists and `replied_user` change
 * which mentions Discord resolves, and nothing here has needed them.
 */
const allowedMentionsSchema = z.strictObject({
    parse: z.array(z.enum(['users', 'roles', 'everyone'])),
});

export const createMessageSchema = z.strictObject({
    content: z.string().max(2000).optional(),
    tts: z.literal(false),
    enforce_nonce: z.literal(false),
    embeds: z.array(embedSchema).max(10).optional(),
    components: z.array(actionRowSchema).max(5).optional(),
    allowed_mentions: allowedMentionsSchema.optional(),
});

/**
 * An edit. Absent members are left alone and present ones replace, exactly as Discord's
 * PATCH treats them. No `allowed_mentions`: discord.js sends the client default on an
 * edit of the bot's own message, and the harness client sets none.
 */
export const editMessageSchema = z.strictObject({
    content: z.string().max(2000).optional(),
    tts: z.literal(false),
    enforce_nonce: z.literal(false),
    embeds: z.array(embedSchema).max(10).optional(),
    components: z.array(actionRowSchema).max(5).optional(),
});

export type CreateMessageBody = z.infer<typeof createMessageSchema>;
export type EditMessageBody = z.infer<typeof editMessageSchema>;
