import { COPY_TOKEN_PATTERN } from '../copyTokens';
import type { DiscordMessageInput } from './messageConfigSchema';
import { MESSAGE_LIMITS } from './messageLimits';
import type { MessagePath } from './messageProblems';
import { parsePictureRef, renderedPictureProblem } from './pictureRef';

/**
 * Reading a message's parts one at a time — its copy, its pictures, its size.
 *
 * Copy and pictures are read off **raw** data, before any schema has judged it: save-time
 * validation looks for tokens in a node as stored, and leaves what is wrong with its shape to
 * the schema. So nothing here assumes the shape — a part that is not where or what it should
 * be is skipped, not reported.
 */

/** One string in a message whose `{{tokens}}` a run fills in, and where an author finds it. */
export interface MessageCopyLocation {
    /** Relative to the message: `['embeds', 1, 'fields', 0, 'value']`. */
    readonly path: MessagePath;
    /**
     * The part as the editor names it, numbered from one: `embed 2 field 1 text`. A caller
     * puts the message's own label in front.
     */
    readonly where: string;
    /** The part's own limit, checked again once the tokens are filled in; absent for a picture. */
    readonly maxLength?: number;
    readonly value: string;
    /**
     * Why the text this part rendered to cannot be sent, or `undefined` when it can — given a
     * caller's full name for the part (`"Message" embed 1 image`). Present on a picture, which
     * must come out as a link: a token is the only way a picture can change at run time, and
     * one that came out as `upload:<id>` would otherwise be attached as an upload nobody
     * picked — read from member-written text, say — past every save-time upload check.
     * Absent on text, which may come out as anything.
     */
    readonly checkRendered?: (where: string, rendered: string) => string | undefined;
}

/** One string-valued part of a message, copy or picture. */
interface MessagePart {
    readonly kind: 'copy' | 'picture';
    readonly path: MessagePath;
    readonly where: string;
    readonly maxLength?: number;
    readonly value: string;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Every string-valued part of a message, in the order a reader meets it: the plain text, then
 * each embed's header, title, body, thumbnail, fields, image and footer.
 */
function messageParts(message: unknown): readonly MessagePart[] {
    if (!isRecord(message)) {
        return [];
    }

    const parts: MessagePart[] = [];
    const add = (kind: MessagePart['kind'], path: MessagePath, where: string, value: unknown, maxLength?: number): void => {
        if (typeof value === 'string') {
            parts.push({ kind, path, where, value, ...(maxLength === undefined ? {} : { maxLength }) });
        }
    };

    add('copy', ['content'], 'plain text', message.content, MESSAGE_LIMITS.content);

    const embeds = Array.isArray(message.embeds) ? message.embeds : [];
    for (const [index, embed] of embeds.entries()) {
        if (!isRecord(embed)) {
            continue;
        }
        const at = (...rest: (string | number)[]): MessagePath => ['embeds', index, ...rest];
        const named = `embed ${index + 1}`;
        const author = isRecord(embed.author) ? embed.author : {};
        const footer = isRecord(embed.footer) ? embed.footer : {};

        add('copy', at('author', 'name'), `${named} header`, author.name, MESSAGE_LIMITS.authorName);
        add('picture', at('author', 'iconUrl'), `${named} header icon`, author.iconUrl);
        add('copy', at('title'), `${named} title`, embed.title, MESSAGE_LIMITS.title);
        add('copy', at('description'), `${named} body`, embed.description, MESSAGE_LIMITS.description);
        add('picture', at('thumbnail'), `${named} thumbnail`, embed.thumbnail);

        const fields = Array.isArray(embed.fields) ? embed.fields : [];
        for (const [fieldIndex, field] of fields.entries()) {
            if (!isRecord(field)) {
                continue;
            }
            const fieldNamed = `${named} field ${fieldIndex + 1}`;
            add('copy', at('fields', fieldIndex, 'name'), `${fieldNamed} heading`, field.name, MESSAGE_LIMITS.fieldName);
            add('copy', at('fields', fieldIndex, 'value'), `${fieldNamed} text`, field.value, MESSAGE_LIMITS.fieldValue);
        }

        add('picture', at('image'), `${named} image`, embed.image);
        add('copy', at('footer', 'text'), `${named} footer`, footer.text, MESSAGE_LIMITS.footerText);
        add('picture', at('footer', 'iconUrl'), `${named} footer icon`, footer.iconUrl);
    }

    return parts;
}

/**
 * Every string in a message whose tokens a run fills in: the plain text, each embed's header,
 * title, body and footer text, each field's heading and text, and each picture that is not an
 * upload (a link, or text holding a token). An upload ref is left out — it holds no tokens,
 * and is attached rather than rendered. Each picture carries `checkRendered`, so whoever
 * renders it refuses one that did not come out as a link.
 *
 * Runs on raw data: a value that is not an object gives nothing, and a part that is not a
 * string is skipped, leaving its shape to the schema.
 */
export function messageCopyLocations(message: unknown): readonly MessageCopyLocation[] {
    return messageParts(message)
        .filter((part) => part.kind === 'copy' || parsePictureRef(part.value)?.kind !== 'upload')
        .map(({ kind, ...location }) => (kind === 'picture' ? { ...location, checkRendered: renderedPictureProblem } : location));
}

/** One picture part of a message — header icon, thumbnail, image or footer icon — and where it sits. */
export interface MessagePicture {
    /** Relative to the message: `['embeds', 0, 'image']`. */
    readonly path: MessagePath;
    /** The part as the editor names it, numbered from one: `embed 1 image`. */
    readonly where: string;
    readonly value: string;
}

/**
 * Every picture part a message holds, upload or not, in the order a reader meets them — each
 * occurrence, so an upload shown twice is listed twice, at both of its places.
 *
 * Reads raw data, as {@link messageCopyLocations} does, so it can be asked of a node as stored.
 */
export function messagePictures(message: unknown): readonly MessagePicture[] {
    return messageParts(message)
        .filter((part) => part.kind === 'picture')
        .map(({ path, where, value }) => ({ path, where, value }));
}

/** One picture part of a message that shows an upload, and which. */
export interface MessageUploadPlace extends MessagePicture {
    readonly uploadId: string;
}

/**
 * Every picture part showing an upload, in the order a reader meets them — each occurrence, so
 * an upload shown twice is listed at both of its places. The one reading of `upload:` refs off a
 * message: attaching, judging and finding uses all start here.
 *
 * Reads raw data, as {@link messageCopyLocations} does, so it can be asked of a node as stored.
 */
export function messageUploadPlaces(message: unknown): readonly MessageUploadPlace[] {
    const places: MessageUploadPlace[] = [];
    for (const picture of messagePictures(message)) {
        const ref = parsePictureRef(picture.value);
        if (ref?.kind === 'upload') {
            places.push({ ...picture, uploadId: ref.uploadId });
        }
    }
    return places;
}

/**
 * Every upload a message's pictures name, each once, in the order first named — so an upload
 * used as both the thumbnail and the footer icon is attached once.
 *
 * Reads raw data, as {@link messageCopyLocations} does, so it can be asked of a node as stored.
 */
export function messageUploadIds(message: unknown): readonly string[] {
    return [...new Set(messageUploadPlaces(message).map((place) => place.uploadId))];
}

/**
 * What {@link messageCharacterCount} counts: every character (`'all'`, a rendered message), or
 * only those outside `{{tokens}}` (`'outsideTokens'`, a message as authored — whatever a token
 * becomes, the text around it is spent already, so this never counts more than a run would).
 */
export type MessageCharacterCounting = 'all' | 'outsideTokens';

/**
 * How many of Discord's 6000 characters a message spends: every embed's title, description,
 * field names and values, footer text and author name. The plain text is not counted, and
 * neither are links or pictures — Discord counts embed text, and counting more would refuse a
 * message it would have taken.
 *
 * Takes a message with or without its defaults filled, so the parsed block value and the
 * stored one can both be asked.
 */
export function messageCharacterCount(message: DiscordMessageInput, counting: MessageCharacterCounting = 'all'): number {
    const length = (text: string | undefined): number => {
        if (!text) return 0;
        return counting === 'all' ? text.length : text.replace(COPY_TOKEN_PATTERN, '').length;
    };
    return message.embeds.reduce(
        (total, embed) =>
            total +
            length(embed.title) +
            length(embed.description) +
            (embed.fields ?? []).reduce((fieldTotal, field) => fieldTotal + length(field.name) + length(field.value), 0) +
            length(embed.footer?.text) +
            length(embed.author?.name),
        0
    );
}
