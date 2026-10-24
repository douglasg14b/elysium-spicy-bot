import { EmbedBuilder } from 'discord.js';
import type { DiscordEmbed, DiscordMessage } from './messageConfigSchema';
import { parsePictureRef } from './pictureRef';

/**
 * One uploaded picture a message attaches, as its caller read it for this guild.
 *
 * A plain shape rather than the uploads repo's row, so this module imports no feature: the
 * caller names the file's extension from the type it stored (`IMAGE_EXTENSIONS` in
 * `features-system/guild-uploads`).
 */
export interface MessageUploadFile {
    readonly uploadId: string;
    /** Without the dot: `png`. */
    readonly extension: string;
    readonly bytes: Buffer;
}

/** A file attached to the message, named as its embeds point at it. */
export interface MessageAttachment {
    readonly attachment: Buffer;
    readonly name: string;
}

/** What `channel.send` takes for a message: its text, its embeds and the uploads they show. */
export interface MessagePayload {
    readonly content?: string;
    readonly embeds: EmbedBuilder[];
    readonly files: MessageAttachment[];
}

/**
 * A message, rendered and checked, as discord.js sends it.
 *
 * An upload picture points at its attachment, `attachment://<uploadId>.<extension>`, and each
 * upload is attached **once**, however many parts show it — and only if a part that is sent
 * shows it: an icon on a header left off for want of text attaches nothing. A link is passed
 * as it is.
 *
 * Expects what a caller has already made sure of, and throws rather than posting something
 * else: every picture that was copy is a link once rendered (`renderedPictureProblem`), and
 * every upload a sent part shows is in `uploads` — a missing one is the caller's to report by
 * name before it gets here. Callers fetch by `messageUploadIds`, which can name a few more
 * (an icon on a header with no text); those are simply not attached.
 */
export function buildMessagePayload(message: DiscordMessage, uploads: readonly MessageUploadFile[]): MessagePayload {
    const byId = new Map(uploads.map((upload) => [upload.uploadId, upload]));
    /** The uploads the sent parts show, in the order they first show them. */
    const shown = new Map<string, MessageUploadFile>();

    const pictureUrl = (picture: string): string => {
        const ref = parsePictureRef(picture);
        switch (ref?.kind) {
            case 'link':
                return ref.url;
            case 'upload': {
                const upload = byId.get(ref.uploadId);
                if (!upload) {
                    throw new Error(`buildMessagePayload was not given upload ${ref.uploadId}, which the message names.`);
                }
                shown.set(upload.uploadId, upload);
                return `attachment://${attachmentName(upload)}`;
            }
            case 'token':
            case undefined:
                throw new Error(
                    `buildMessagePayload was handed the picture "${picture}", which is not a link or an upload. ` +
                        'Render the message and check its pictures first.'
                );
        }
    };

    const embeds = message.embeds.map((embed) => buildEmbed(embed, pictureUrl));
    return {
        ...(message.content ? { content: message.content } : {}),
        embeds,
        files: [...shown.values()].map((upload): MessageAttachment => ({ attachment: upload.bytes, name: attachmentName(upload) })),
    };
}

/** The name an upload is attached under, and that its embeds point at. */
function attachmentName(upload: MessageUploadFile): string {
    return `${upload.uploadId}.${upload.extension}`;
}

/**
 * One embed, with each picture turned into the link Discord reads.
 *
 * A header or footer with no text is left off: `messageProblems` refuses one at save, and
 * Discord would drop its icon anyway.
 */
function buildEmbed(embed: DiscordEmbed, pictureUrl: (picture: string) => string): EmbedBuilder {
    const builder = new EmbedBuilder();

    if (embed.color) {
        builder.setColor(Number.parseInt(embed.color.slice(1), 16));
    }
    if (embed.author?.name) {
        builder.setAuthor({
            name: embed.author.name,
            ...(embed.author.iconUrl ? { iconURL: pictureUrl(embed.author.iconUrl) } : {}),
        });
    }
    if (embed.title) {
        builder.setTitle(embed.title);
    }
    if (embed.url) {
        builder.setURL(embed.url);
    }
    if (embed.description) {
        builder.setDescription(embed.description);
    }
    if (embed.thumbnail) {
        builder.setThumbnail(pictureUrl(embed.thumbnail));
    }
    if (embed.fields.length > 0) {
        builder.addFields(embed.fields.map((field) => ({ name: field.name, value: field.value, inline: field.inline })));
    }
    if (embed.image) {
        builder.setImage(pictureUrl(embed.image));
    }
    if (embed.footer?.text) {
        builder.setFooter({
            text: embed.footer.text,
            ...(embed.footer.iconUrl ? { iconURL: pictureUrl(embed.footer.iconUrl) } : {}),
        });
    }
    if (embed.timestamp) {
        builder.setTimestamp(new Date());
    }

    return builder;
}
