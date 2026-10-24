import { z } from 'zod';
import { MESSAGE_LIMITS } from './messageLimits';
import { HTTP_LINK_PATTERN } from './pictureRef';

/**
 * A Discord message as an author builds it: plain text above, then up to ten embeds.
 *
 * **Built by a function**, so the block's schema and the wire's `DiscordMessage` are one
 * structure with one set of per-part rules. They differ in two ways, both chosen by the
 * caller:
 *
 * - **How a picture is judged.** The block passes the refined `pictureRefSchema`, the wire a
 *   plain `z.string()` — a request schema cannot carry a refinement to the browser.
 * - **Whether defaults are filled.** The block fills `fields`, each field's `inline` and
 *   `timestamp`, so `run` receives complete embeds. The wire leaves them optional, so its
 *   parsed type is the block's *input* — what a node stores and a field's default declares —
 *   which is also what the generated `DiscordMessage` says. Both take and refuse the same
 *   values.
 *
 * Every rule here is one the browser can be given exactly — a length with a fixed sentence,
 * or a flagless `.regex()` — and the rules spanning parts live in `messageProblems`, run by
 * the block's `superRefine`.
 *
 * **Absent means left out.** A part the author cleared is removed rather than written as `''`,
 * which the `.min(1)`s refuse. The header's name and the footer's text are optional inside
 * their objects so that a lone icon reaches `messageProblems`, which says why Discord would
 * drop it, rather than zod's sentence about a missing string.
 */

/** How the block's side and the wire's side build the one structure. */
export interface MessageShapeOptions<Picture extends z.ZodType<string, string>, FillDefaults extends boolean> {
    /** What judges every picture part: refined on the block's side, a plain string on the wire's. */
    readonly picture: Picture;
    /** Fill `fields`, `inline` and `timestamp` when absent (the block), or leave them optional (the wire). */
    readonly fillDefaults: FillDefaults;
}

/** A part with a fallback: defaulted when filling, optional when not. */
type Fallback<Schema extends z.ZodType, FillDefaults extends boolean> = FillDefaults extends true
    ? z.ZodDefault<Schema>
    : z.ZodOptional<Schema>;

/**
 * `schema` defaulted to `value`, or optional — the one place the two sides part. The cast
 * names the branch taken, which TypeScript cannot follow through a runtime boolean.
 */
function fallback<Schema extends z.ZodType, FillDefaults extends boolean>(
    schema: Schema,
    value: z.output<Schema>,
    fillDefaults: FillDefaults
): Fallback<Schema, FillDefaults> {
    return (fillDefaults ? schema.default(value as never) : schema.optional()) as Fallback<Schema, FillDefaults>;
}

/**
 * The message's structure, with `picture` judging every picture part — the header and footer
 * icons, the thumbnail and the image.
 */
export function messageShape<Picture extends z.ZodType<string, string>, FillDefaults extends boolean>({
    picture,
    fillDefaults,
}: MessageShapeOptions<Picture, FillDefaults>) {
    /** `#RRGGBB`, the BrattyBot cyan being `#00A2FF`. */
    const colourSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Colour must be a hex value like #00A2FF');

    /** The title's link: http(s) only, because Discord refuses anything else on an embed. */
    const titleLinkSchema = z
        .string()
        .regex(HTTP_LINK_PATTERN, 'A title link has to be a full link starting http:// or https://.');

    const fieldSchema = z.object({
        name: z
            .string()
            .min(1, 'A field needs a heading.')
            .max(MESSAGE_LIMITS.fieldName, `Field headings stop at ${MESSAGE_LIMITS.fieldName} characters.`),
        value: z
            .string()
            .min(1, 'A field needs some text under its heading.')
            .max(MESSAGE_LIMITS.fieldValue, `Field text stops at ${MESSAGE_LIMITS.fieldValue} characters.`),
        inline: fallback(z.boolean(), false, fillDefaults),
    });

    const embedSchema = z.object({
        color: colourSchema.optional(),
        author: z
            .object({
                name: z
                    .string()
                    .min(1, 'Header text needs at least one character — or leave the header out.')
                    .max(MESSAGE_LIMITS.authorName, `Header text stops at ${MESSAGE_LIMITS.authorName} characters.`)
                    .optional(),
                iconUrl: picture.optional(),
            })
            .optional(),
        title: z
            .string()
            .min(1, 'A title needs at least one character — or leave it out.')
            .max(MESSAGE_LIMITS.title, `Titles stop at ${MESSAGE_LIMITS.title} characters.`)
            .optional(),
        url: titleLinkSchema.optional(),
        description: z
            .string()
            .min(1, 'The body needs at least one character — or leave it out.')
            .max(MESSAGE_LIMITS.description, `An embed body stops at ${MESSAGE_LIMITS.description} characters.`)
            .optional(),
        fields: fallback(
            z.array(fieldSchema).max(MESSAGE_LIMITS.fields, `An embed holds ${MESSAGE_LIMITS.fields} fields, tops.`),
            [],
            fillDefaults
        ),
        thumbnail: picture.optional(),
        image: picture.optional(),
        footer: z
            .object({
                text: z
                    .string()
                    .min(1, 'Footer text needs at least one character — or leave the footer out.')
                    .max(MESSAGE_LIMITS.footerText, `Footer text stops at ${MESSAGE_LIMITS.footerText} characters.`)
                    .optional(),
                iconUrl: picture.optional(),
            })
            .optional(),
        timestamp: fallback(z.boolean(), false, fillDefaults),
    });

    return z.object({
        content: z
            .string()
            .min(1, 'Plain text needs at least one character — or leave it out.')
            .max(MESSAGE_LIMITS.content, `Plain text stops at ${MESSAGE_LIMITS.content} characters — Discord's rule, not ours.`)
            .optional(),
        embeds: z
            .array(embedSchema)
            .max(MESSAGE_LIMITS.embeds, `${MESSAGE_LIMITS.embeds} embeds is the most Discord takes in one message.`),
    });
}
