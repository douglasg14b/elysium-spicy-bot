/**
 * Every edit the message window makes, as a pure function of the message before it.
 *
 * Each one returns a **new** message and never touches the one it was given: the result
 * goes straight to the node's `onChange`, into React state and the builder's undo history,
 * and a message edited in place would be a change neither can see (see `ControlChange`).
 * Only the containers on the way to the edited part are rebuilt; everything else is shared.
 *
 * **Absent means left out.** A text part cleared to nothing, or a picture removed, loses
 * its key — the server's `.min(1)`s refuse `''` — and a header or footer left with no part
 * at all goes with it. A field's heading and text are the exception: a field cannot be
 * without them, so they stay as `''` and the server says so.
 *
 * The shape is the SDK's generated `DiscordMessage`, so nothing here restates it.
 */

import type { DiscordMessage } from '@brattybot/web-sdk';

export type MessageDraft = DiscordMessage;
export type EmbedDraft = DiscordMessage['embeds'][number];
export type FieldDraft = NonNullable<EmbedDraft['fields']>[number];

/**
 * The text parts that sit on an embed itself, rather than in one of its fields — every one the
 * window draws. The one list: the types below and the complaint placement read it.
 */
export const EMBED_TEXT_KINDS = ['authorName', 'title', 'url', 'description', 'footerText'] as const;

/** The four places an embed shows a picture — the one list, as {@link EMBED_TEXT_KINDS} is. */
export const PICTURE_KINDS = ['authorIcon', 'thumbnail', 'image', 'footerIcon'] as const;

/** A text part that sits on an embed itself, rather than in one of its fields. */
export type EmbedTextKind = (typeof EMBED_TEXT_KINDS)[number];

/** One piece of text in a message, by where it sits. */
export type TextPart =
    | { readonly kind: 'content' }
    | { readonly kind: EmbedTextKind; readonly embed: number }
    | { readonly kind: 'fieldName' | 'fieldValue'; readonly embed: number; readonly field: number };

/** The four places an embed shows a picture. */
export type PictureKind = (typeof PICTURE_KINDS)[number];

/** One picture in a message, by where it sits. */
export interface PicturePart {
    readonly kind: PictureKind;
    readonly embed: number;
}

/** Which way a move goes: towards the top, or towards the bottom. */
export type MoveDirection = -1 | 1;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function textOf(value: unknown): string | undefined {
    return typeof value === 'string' ? value : undefined;
}

/** `{ [key]: value }` when there is a value, else nothing — for building without `undefined` keys. */
function present<TKey extends string, TValue>(key: TKey, value: TValue | undefined): Partial<Record<TKey, TValue>> {
    return value === undefined ? {} : ({ [key]: value } as Record<TKey, TValue>);
}

/** A header or footer read from storage: its string parts, or nothing when it has none. */
function readPair<TText extends 'name' | 'text'>(
    raw: unknown,
    textKey: TText
): (Partial<Record<TText, string>> & { iconUrl?: string }) | undefined {
    if (!isRecord(raw)) return undefined;
    const pair = { ...present(textKey, textOf(raw[textKey])), ...present('iconUrl', textOf(raw.iconUrl)) };
    return Object.keys(pair).length > 0 ? pair : undefined;
}

function flagOf(value: unknown): boolean | undefined {
    return typeof value === 'boolean' ? value : undefined;
}

function readField(raw: unknown): FieldDraft {
    const field = isRecord(raw) ? raw : {};
    return {
        name: textOf(field.name) ?? '',
        value: textOf(field.value) ?? '',
        ...present('inline', flagOf(field.inline)),
    };
}

function readEmbed(raw: unknown): EmbedDraft {
    if (!isRecord(raw)) return {};
    const fields = Array.isArray(raw.fields) ? raw.fields.map(readField) : undefined;
    return {
        ...present('color', textOf(raw.color)),
        ...present('author', readPair(raw.author, 'name')),
        ...present('title', textOf(raw.title)),
        ...present('url', textOf(raw.url)),
        ...present('description', textOf(raw.description)),
        ...present('thumbnail', textOf(raw.thumbnail)),
        ...present('fields', fields),
        ...present('image', textOf(raw.image)),
        ...present('footer', readPair(raw.footer, 'text')),
        ...present('timestamp', flagOf(raw.timestamp)),
    };
}

/**
 * A stored `message` value as something the window can edit, or `undefined` when it holds
 * none (a node that has never had one).
 *
 * Read part by part rather than parsed, because an unfinished message is stored as it was
 * left — a title over Discord's limit must still open, so it can be cut. A part that is not
 * the type it should be is left out, and an embed that is not an object reads as an empty
 * one, so every embed keeps the position the server's complaints address it by. Anything of
 * the right type is kept exactly — an empty field list, an `inline: false` — so a message the
 * server stored reads back equal to itself, which is what lets Cancel put it back as it was.
 */
export function readMessageDraft(raw: unknown): MessageDraft | undefined {
    if (!isRecord(raw)) return undefined;
    const embeds = Array.isArray(raw.embeds) ? raw.embeds.map(readEmbed) : [];
    return { ...present('content', textOf(raw.content)), embeds };
}

/** An embed with nothing in it yet, in `colour` when one is given. */
export function newEmbed(colour: string | undefined): EmbedDraft {
    return present('color', colour);
}

/** What a message with nothing in it opens as: one fresh embed. */
export function startingMessage(colour: string | undefined): MessageDraft {
    return { embeds: [newEmbed(colour)] };
}

/** `message` with embed `index` replaced by what `edit` makes of it. */
function updateEmbed(message: MessageDraft, index: number, edit: (embed: EmbedDraft) => EmbedDraft): MessageDraft {
    return { ...message, embeds: message.embeds.map((embed, at) => (at === index ? edit(embed) : embed)) };
}

/** `embed` with `key` set to `value`, or without `key` when there is none. */
function withKey<TKey extends keyof EmbedDraft>(embed: EmbedDraft, key: TKey, value: EmbedDraft[TKey] | undefined): EmbedDraft {
    const { [key]: _dropped, ...rest } = embed;
    return value === undefined ? rest : { ...rest, [key]: value };
}

/** A header or footer with one part set or removed — and nothing at all once it is empty. */
function withPairPart<TPair extends object>(pair: TPair | undefined, key: keyof TPair, value: string | undefined): TPair | undefined {
    const { [key]: _dropped, ...rest } = pair ?? ({} as TPair);
    const next = value === undefined ? rest : { ...rest, [key]: value };
    return Object.keys(next).length > 0 ? (next as TPair) : undefined;
}

/** `list` with the entry at `index` swapped with its neighbour in `direction`; unchanged at an end. */
function moved<TEntry>(list: readonly TEntry[], index: number, direction: MoveDirection): TEntry[] {
    const target = index + direction;
    if (index < 0 || index >= list.length || target < 0 || target >= list.length) return [...list];
    const next = [...list];
    [next[index], next[target]] = [next[target] as TEntry, next[index] as TEntry];
    return next;
}

/** What a text part holds, or `undefined` when it is left out. */
export function readTextPart(message: MessageDraft, part: TextPart): string | undefined {
    if (part.kind === 'content') return message.content;
    const embed = message.embeds[part.embed];
    if (!embed) return undefined;
    switch (part.kind) {
        case 'authorName':
            return embed.author?.name;
        case 'footerText':
            return embed.footer?.text;
        case 'fieldName':
            return embed.fields?.[part.field]?.name;
        case 'fieldValue':
            return embed.fields?.[part.field]?.value;
        case 'title':
        case 'url':
        case 'description':
            return embed[part.kind];
    }
}

/**
 * Whether emptying a text part leaves it out of the message. Every part but a field's heading
 * and text: a field cannot be without them, so an emptied one stays `''` for the server to name.
 */
export function isRemovablePart(part: TextPart): boolean {
    return part.kind !== 'fieldName' && part.kind !== 'fieldValue';
}

/**
 * Whether Discord shows a `<#channel>` in this part as a link. It does in the plain text, an
 * embed's description and a field's text; everywhere else it shows `<#…>` as written.
 */
export function showsChannelLinks(part: TextPart): boolean {
    switch (part.kind) {
        case 'content':
        case 'description':
        case 'fieldValue':
            return true;
        case 'authorName':
        case 'title':
        case 'url':
        case 'footerText':
        case 'fieldName':
            return false;
        default: {
            const illegal: never = part;
            throw new Error(`Unknown text part ${JSON.stringify(illegal)}.`);
        }
    }
}

/** `message` with a text part set to `text` — or left out, when `text` is empty and {@link isRemovablePart}. */
export function setTextPart(message: MessageDraft, part: TextPart, text: string): MessageDraft {
    const value = text === '' && isRemovablePart(part) ? undefined : text;
    if (part.kind === 'content') {
        const { content: _dropped, ...rest } = message;
        return value === undefined ? rest : { ...rest, content: value };
    }
    return updateEmbed(message, part.embed, (embed) => {
        switch (part.kind) {
            case 'authorName':
                return withKey(embed, 'author', withPairPart(embed.author, 'name', value));
            case 'footerText':
                return withKey(embed, 'footer', withPairPart(embed.footer, 'text', value));
            case 'fieldName':
            case 'fieldValue': {
                const key = part.kind === 'fieldName' ? 'name' : 'value';
                const fields = (embed.fields ?? []).map((field, at) => (at === part.field ? { ...field, [key]: text } : field));
                return { ...embed, fields };
            }
            case 'title':
            case 'url':
            case 'description':
                return withKey(embed, part.kind, value);
        }
    });
}

/** What a picture part holds — `upload:<id>`, a link, or text with a token — or `undefined` when there is none. */
export function readPicture(message: MessageDraft, part: PicturePart): string | undefined {
    const embed = message.embeds[part.embed];
    switch (part.kind) {
        case 'authorIcon':
            return embed?.author?.iconUrl;
        case 'footerIcon':
            return embed?.footer?.iconUrl;
        case 'thumbnail':
        case 'image':
            return embed?.[part.kind];
    }
}

/** `message` with a picture set to `ref`, or removed when `ref` is `undefined` or empty. */
export function setPicture(message: MessageDraft, part: PicturePart, ref: string | undefined): MessageDraft {
    const value = ref || undefined;
    return updateEmbed(message, part.embed, (embed) => {
        switch (part.kind) {
            case 'authorIcon':
                return withKey(embed, 'author', withPairPart(embed.author, 'iconUrl', value));
            case 'footerIcon':
                return withKey(embed, 'footer', withPairPart(embed.footer, 'iconUrl', value));
            case 'thumbnail':
            case 'image':
                return withKey(embed, part.kind, value);
        }
    });
}

/** `message` with a fresh embed added at the bottom, in `colour` when one is given. */
export function addEmbed(message: MessageDraft, colour: string | undefined): MessageDraft {
    return { ...message, embeds: [...message.embeds, newEmbed(colour)] };
}

/** `message` with embed `index` swapped with its neighbour; unchanged at an end. */
export function moveEmbed(message: MessageDraft, index: number, direction: MoveDirection): MessageDraft {
    return { ...message, embeds: moved(message.embeds, index, direction) };
}

/**
 * `message` with a copy of embed `index` straight after it. The copy is its own object all
 * the way down, so editing one never shows up in the other.
 */
export function duplicateEmbed(message: MessageDraft, index: number): MessageDraft {
    const original = message.embeds[index];
    if (!original) return { ...message, embeds: [...message.embeds] };
    const copy: EmbedDraft = {
        ...original,
        ...present('author', original.author ? { ...original.author } : undefined),
        ...present('footer', original.footer ? { ...original.footer } : undefined),
        ...present('fields', original.fields?.map((field) => ({ ...field }))),
    };
    return { ...message, embeds: [...message.embeds.slice(0, index + 1), copy, ...message.embeds.slice(index + 1)] };
}

/** `message` without embed `index`. */
export function deleteEmbed(message: MessageDraft, index: number): MessageDraft {
    return { ...message, embeds: message.embeds.filter((_embed, at) => at !== index) };
}

/** `message` with an empty field added to embed `embedIndex`, ready for its heading. */
export function addField(message: MessageDraft, embedIndex: number): MessageDraft {
    return updateEmbed(message, embedIndex, (embed) => ({ ...embed, fields: [...(embed.fields ?? []), { name: '', value: '' }] }));
}

/** `message` without field `fieldIndex` of embed `embedIndex` — and without the list once it is empty. */
export function removeField(message: MessageDraft, embedIndex: number, fieldIndex: number): MessageDraft {
    return updateEmbed(message, embedIndex, (embed) => {
        const fields = (embed.fields ?? []).filter((_field, at) => at !== fieldIndex);
        return withKey(embed, 'fields', fields.length > 0 ? fields : undefined);
    });
}

/** `message` with a field swapped with its neighbour in its embed; unchanged at an end. */
export function moveField(message: MessageDraft, embedIndex: number, fieldIndex: number, direction: MoveDirection): MessageDraft {
    return updateEmbed(message, embedIndex, (embed) => ({ ...embed, fields: moved(embed.fields ?? [], fieldIndex, direction) }));
}

/** `message` with a field sitting beside its neighbours (`inline`) or on a row of its own. */
export function setFieldInline(message: MessageDraft, embedIndex: number, fieldIndex: number, inline: boolean): MessageDraft {
    return updateEmbed(message, embedIndex, (embed) => ({
        ...embed,
        fields: (embed.fields ?? []).map((field, at) => {
            if (at !== fieldIndex) return field;
            const { inline: _dropped, ...rest } = field;
            return inline ? { ...rest, inline: true } : rest;
        }),
    }));
}

/** `message` with embed `index` in `colour`, or in Discord's grey when `colour` is `undefined`. */
export function setColour(message: MessageDraft, index: number, colour: string | undefined): MessageDraft {
    return updateEmbed(message, index, (embed) => withKey(embed, 'color', colour || undefined));
}

/** `message` with embed `index` showing when it was posted, or not. */
export function setTimestamp(message: MessageDraft, index: number, shown: boolean): MessageDraft {
    return updateEmbed(message, index, (embed) => withKey(embed, 'timestamp', shown ? true : undefined));
}

/** What each part is called after its embed's number, as the server's failures name it. */
const PART_NAMES: Readonly<Record<EmbedTextKind | PictureKind, string>> = {
    authorName: 'header',
    authorIcon: 'header icon',
    title: 'title',
    url: 'title link',
    description: 'body',
    thumbnail: 'thumbnail',
    image: 'image',
    footerText: 'footer',
    footerIcon: 'footer icon',
};

/** What a picture is called without its embed's number: `image`, `footer icon`. */
export function partNoun(kind: PictureKind): string {
    return PART_NAMES[kind];
}

/**
 * A part as an author finds it, numbered from one — `Embed 2 title`, `Embed 1 field 3 text` —
 * in the words the server's own failures use (`messageCopyLocations`), so a run that failed
 * on a part and the window's box for it are called the same thing.
 * `src/shared/discordMessage/__tests__/messageMeterDrift.test.ts` holds the two together, with
 * {@link partPath}.
 */
export function partLabel(part: TextPart | PicturePart): string {
    if (part.kind === 'content') return 'Plain text';
    const embed = `Embed ${part.embed + 1}`;
    switch (part.kind) {
        case 'fieldName':
            return `${embed} field ${part.field + 1} heading`;
        case 'fieldValue':
            return `${embed} field ${part.field + 1} text`;
        default:
            return `${embed} ${PART_NAMES[part.kind]}`;
    }
}

/**
 * Where a part sits, dotted as the server addresses a complaint about it (relative to the
 * message): `content`, `embeds.0.title`, `embeds.1.fields.2.value`, `embeds.0.footer.iconUrl`.
 */
export function partPath(part: TextPart | PicturePart): string {
    if (part.kind === 'content') return 'content';
    const embed = `embeds.${part.embed}`;
    switch (part.kind) {
        case 'authorName':
            return `${embed}.author.name`;
        case 'authorIcon':
            return `${embed}.author.iconUrl`;
        case 'footerText':
            return `${embed}.footer.text`;
        case 'footerIcon':
            return `${embed}.footer.iconUrl`;
        case 'fieldName':
            return `${embed}.fields.${part.field}.name`;
        case 'fieldValue':
            return `${embed}.fields.${part.field}.value`;
        case 'title':
        case 'url':
        case 'description':
        case 'thumbnail':
        case 'image':
            return `${embed}.${part.kind}`;
    }
}
