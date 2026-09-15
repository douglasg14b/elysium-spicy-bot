import { EmbedBuilder } from 'discord.js';
import { z } from 'zod';
import type { BlockManifest } from '../manifest';

export const ACTION_POST_EMBED = 'action.postEmbed';

/**
 * Discord's own limits on an embed, in characters.
 *
 * Held by the schema rather than trusted, for the reason
 * `DISCORD_BUTTON_LABEL_MAX_LENGTH` gives one layer up: Discord rejects the whole
 * message when any one of these is over, so an author who pastes an essay would
 * otherwise get a failed run at post time rather than a save they can fix while
 * looking at the field.
 *
 * Not in `constants.ts`: that file is inside the engine-vocabulary gate, and
 * these are facts about *an embed* rather than about the interpreter. A block is
 * where a named Discord capability's limits belong.
 */
const EMBED_LIMITS = {
    title: 256,
    description: 4096,
    fieldName: 256,
    fieldValue: 1024,
    footer: 2048,
    authorName: 256,
    fields: 25,
    /**
     * The sum of title, description, every field name and value, the footer and
     * the author name. Discord counts these together and rejects the message when
     * they exceed this, however comfortably each one fits on its own.
     */
    total: 6000,
} as const;

/**
 * Hex colour like `#00A2FF` (the SpicyBot cyan).
 *
 * **Stays optional.** A newly dropped node is seeded with the brand cyan by the
 * field's `defaultValue`, so an author who never opens the colour picker still
 * gets the product's own colour rather than Discord's grey. But absence remains
 * valid and must: every graph saved before that default existed carries no
 * `color`, as does anything written straight through the API, and `run` still
 * guards with `if (config.color)`. Removing `.optional()` to match the default
 * would make those existing rows unparseable.
 */
const hexColorSchema = z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, 'Colour must be a hex value like #00A2FF');

/**
 * A URL Discord will accept on an embed.
 *
 * `http(s)` only, and checked rather than passed through: discord.js rejects a
 * malformed url by throwing out of the builder, which would surface as an
 * unexplained failed run instead of a save-time complaint naming the field.
 */
const embedUrlSchema = z
    .string()
    .url('Must be a full URL, starting http:// or https://')
    .refine((value) => /^https?:\/\//i.test(value), 'Only http:// and https:// links work in an embed');

/**
 * One `{ name, value, inline }` row.
 *
 * `inline` carries a `.default(false)` rather than being optional, so the stored
 * shape is the same whether an author touched the checkbox or not — an entry that
 * omitted it would otherwise read back as a different shape from one that set it
 * false, for no difference in what gets posted.
 */
const embedFieldSchema = z.object({
    name: z.string().min(1).max(EMBED_LIMITS.fieldName),
    value: z.string().min(1).max(EMBED_LIMITS.fieldValue),
    inline: z.boolean().default(false),
});

export type EmbedFieldConfig = z.infer<typeof embedFieldSchema>;

/**
 * **Every key added here after `color` is optional, and that is load-bearing.**
 *
 * Every graph saved before this block grew past title/description/colour holds
 * exactly `{ channelId, title, description, color? }`. Those rows are read back
 * through this schema on every run and on every load, so a required key added
 * here would make each of them unparseable — the flow would stop working and the
 * builder could not open it to fix. The reasoning is the same one `hexColorSchema`
 * records for `color`, and it applies to all of it: `fields` defaults to `[]`
 * rather than being required, and every scalar below is `.optional()`.
 */
export const postEmbedConfigSchema = z.object({
    channelId: z.string().min(1),
    title: z.string().min(1).max(EMBED_LIMITS.title),
    description: z.string().min(1).max(EMBED_LIMITS.description),
    color: hexColorSchema.optional(),
    url: embedUrlSchema.optional(),
    authorName: z.string().min(1).max(EMBED_LIMITS.authorName).optional(),
    fields: z.array(embedFieldSchema).max(EMBED_LIMITS.fields).default([]),
    imageUrl: embedUrlSchema.optional(),
    thumbnailUrl: embedUrlSchema.optional(),
    footerText: z.string().min(1).max(EMBED_LIMITS.footer).optional(),
    /*
     * Stored as the string the `segmented` control writes, and left as one.
     *
     * There is no scalar boolean control in the vocabulary — `objectList`'s
     * `toggle` is a *column*, not a field — and adding one for a single call site
     * is the "framework for one call site" `implementation-philosophy.md` rejects.
     * Two segments labelled No and Yes is what that control is for.
     *
     * A `.transform()` to a real boolean was the obvious next step and is
     * deliberately **not** taken: `checkFieldDefault` reveals a schema's default by
     * parsing `undefined`, which on a transforming schema yields the *output*
     * (`false`) while a config field declares its default as *input* (`'false'`).
     * The two can then never agree, and the block fails conformance for being
     * written in a shape the check cannot read. Keeping the parsed type equal to
     * the stored type is the honest fix; `run` does the one comparison.
     */
    showTimestamp: z.enum(['true', 'false']).default('false'),
});

export type PostEmbedConfig = z.infer<typeof postEmbedConfigSchema>;

/** `#00A2FF` -> 0x00A2FF, the integer form discord.js embeds want. */
export function hexColorToInt(hex: string): number {
    return Number.parseInt(hex.slice(1), 16);
}

/**
 * This embed's field rows, tolerating a config that never met the schema.
 *
 * `fields` carries a `.default([])`, so anything that came through `safeParse` —
 * which is every path the executor takes — has a real array here. What does not
 * is a config handed straight to `run`, which the block's own tests do and which
 * an older saved graph's `node.data` literally is: `{channelId, title,
 * description}` and nothing else.
 *
 * Reading it through one accessor rather than guarding at each use keeps that
 * fact in one place instead of two `?? []`s that look like nervousness. It is
 * **not** a silent fallback in the sense `root-cause-over-workarounds` warns
 * about: an embed with no fields is a completely valid embed and the empty list
 * is its real value, not a recovery from a missing one.
 */
function fieldsOf(config: PostEmbedConfig): readonly EmbedFieldConfig[] {
    return config.fields ?? [];
}

/**
 * Every character Discord counts toward the 6000 an embed may hold.
 *
 * The url fields are absent deliberately — Discord counts *text*, and an image
 * url is not shown as any. Counting them would reject an embed Discord would have
 * accepted, which is the worse of the two errors here.
 */
export function embedCharacterCount(config: PostEmbedConfig): number {
    const fieldText = fieldsOf(config).reduce(
        (total, field) => total + field.name.length + field.value.length,
        0
    );

    return (
        config.title.length +
        config.description.length +
        fieldText +
        (config.footerText?.length ?? 0) +
        (config.authorName?.length ?? 0)
    );
}

export const block: BlockManifest<PostEmbedConfig> = {
    type: ACTION_POST_EMBED,
    kind: 'action',
    label: 'Post Embed',
    description: 'Post something that looks like you meant it — title, blurb, fields, and a colour stripe.',
    group: 'actions',
    icon: '🖼️',
    configSchema: postEmbedConfigSchema,
    configFields: [
        {
            key: 'channelId',
            label: 'Channel',
            description: 'Where the embed gets posted.',
            control: 'channelPicker',
        },
        {
            key: 'title',
            label: 'Title',
            control: 'text',
            placeholder: 'House Rules',
            maxLength: EMBED_LIMITS.title,
            rendersTokens: true,
        },
        {
            key: 'description',
            label: 'Body',
            control: 'longText',
            placeholder: 'The fine print nobody reads…',
            maxLength: EMBED_LIMITS.description,
            rendersTokens: true,
        },
        {
            key: 'fields',
            label: 'Fields',
            description: `Named sections under the body. Up to ${EMBED_LIMITS.fields}. Inline ones sit side by side, three to a row.`,
            control: 'objectList',
            columns: [
                {
                    key: 'name',
                    label: 'Heading',
                    control: 'text',
                    placeholder: 'Safewords',
                    maxLength: EMBED_LIMITS.fieldName,
                    rendersTokens: true,
                },
                {
                    key: 'value',
                    label: 'Text',
                    control: 'longText',
                    placeholder: 'Red means stop. No, really.',
                    maxLength: EMBED_LIMITS.fieldValue,
                    rendersTokens: true,
                },
                { key: 'inline', label: 'Side by side', control: 'toggle' },
            ],
            maxEntries: EMBED_LIMITS.fields,
            addLabel: 'Add a field',
            defaultValue: [],
        },
        {
            key: 'color',
            label: 'Accent colour',
            description: 'The stripe down the side of the embed.',
            control: 'colour',
            defaultValue: '#00A2FF',
            swatches: ['#00A2FF', '#FF2D95', '#7A5CFF', '#FF6B35'],
        },
        {
            key: 'authorName',
            label: 'Author line',
            description: 'Small text above the title. Leave empty for none.',
            control: 'text',
            placeholder: 'The Management',
            maxLength: EMBED_LIMITS.authorName,
            rendersTokens: true,
        },
        {
            key: 'url',
            label: 'Title link',
            description: 'Makes the title clickable. Leave empty for none.',
            control: 'text',
            placeholder: 'https://example.com/rules',
        },
        {
            key: 'imageUrl',
            label: 'Image',
            description: 'A big picture across the bottom.',
            control: 'text',
            placeholder: 'https://example.com/pic.png',
        },
        {
            key: 'thumbnailUrl',
            label: 'Thumbnail',
            description: 'A small picture in the top corner.',
            control: 'text',
            placeholder: 'https://example.com/icon.png',
        },
        {
            key: 'footerText',
            label: 'Footer',
            description: 'Small print along the bottom. Leave empty for none.',
            control: 'text',
            placeholder: 'Behave yourselves.',
            maxLength: EMBED_LIMITS.footer,
            rendersTokens: true,
        },
        {
            key: 'showTimestamp',
            label: 'Timestamp',
            description: 'Stamp it with the time it was posted.',
            control: 'segmented',
            options: [
                { value: 'false', label: 'No' },
                { value: 'true', label: 'Yes' },
            ],
            defaultValue: 'false',
        },
    ],
    cardSummary: [
        { key: 'channelId', emptyText: 'no channel picked' },
        { key: 'title', prefix: ' · ', quote: true, truncate: 20, hideWhenEmpty: true },
        { key: 'fields', prefix: ' · ', hideWhenEmpty: true },
    ],
    handles: [{ label: 'Then', tone: 'neutral' }],
    outputs: [],
    requires: [],
    capabilities: ['sendMessages', 'embedLinks'],
    canSuspend: false,
    async run(config, context) {
        const channel = await context.client.channels.fetch(config.channelId);
        // Thrown rather than returned as `fail` — see the note on `action.sendMessage`.
        if (!channel || !channel.isTextBased() || !('send' in channel)) {
            throw new Error(`Channel ${config.channelId} is not a sendable text channel`);
        }

        /*
         * The one limit the schema cannot hold, checked here.
         *
         * Every individual cap above is a property of one field and lives on that
         * field, where the control can show it and the author can see which line
         * is too long. The 6000 is a property of the *whole* embed, so it can only
         * be false for a combination of fields each of which is individually
         * legal — and it is only knowable after tokens expand, since
         * `{{subject.username}}` is 19 characters that become however long a
         * member's name is.
         *
         * Failing here rather than truncating, and naming the number: a silently
         * trimmed embed drops whichever field happened to be last, which an author
         * would read as the flow being broken rather than as their embed being too
         * long. This is `root-cause-over-workarounds` applied to a real limit —
         * an over-length embed must fail nameably.
         */
        const characters = embedCharacterCount(config);
        if (characters > EMBED_LIMITS.total) {
            return {
                kind: 'fail',
                error:
                    `This embed is ${characters} characters once its tokens are filled in, and Discord's ` +
                    `limit across the whole embed is ${EMBED_LIMITS.total}. Trim the body or drop a field — ` +
                    'each part is within its own limit, it is the total that is over.',
            };
        }

        const embed = new EmbedBuilder().setTitle(config.title).setDescription(config.description);

        if (config.color) {
            embed.setColor(hexColorToInt(config.color));
        }
        if (config.url) {
            embed.setURL(config.url);
        }
        if (config.authorName) {
            embed.setAuthor({ name: config.authorName });
        }
        if (config.imageUrl) {
            embed.setImage(config.imageUrl);
        }
        if (config.thumbnailUrl) {
            embed.setThumbnail(config.thumbnailUrl);
        }
        if (config.footerText) {
            embed.setFooter({ text: config.footerText });
        }
        if (config.showTimestamp === 'true') {
            embed.setTimestamp(new Date());
        }
        const fields = fieldsOf(config);
        if (fields.length > 0) {
            embed.addFields(
                fields.map((field) => ({
                    name: field.name,
                    value: field.value,
                    // `.default(false)` on the schema, so this is set on anything
                    // parsed. An older row predating the column reads as absent,
                    // and Discord's own default for a field is not inline.
                    inline: field.inline ?? false,
                }))
            );
        }

        // Embed text does not ping on its own, but the allowlist is stated here too
        // so no send path in this feature is the one that forgot.
        await channel.send({ embeds: [embed], allowedMentions: { parse: [] } });
        return { kind: 'continue' };
    },
};
