/** `https://discord.com/channels/<guild>/<channel>[/<message>]`, from any of Discord's hosts. */
const MESSAGE_LINK = /^<?https?:\/\/(?:(?:ptb|canary)\.)?discord(?:app)?\.com\/channels\/(\d+)\/(\d+)(?:\/(\d+))?>?$/;

type MessageLink = { readonly guildId: string; readonly channelId: string; readonly messageId: string | null };

/** A Discord message or channel link, or null when `text` is not one. */
export function parseMessageLink(text: string): MessageLink | null {
    const match = MESSAGE_LINK.exec(text.trim());
    if (!match) return null;
    const [, guildId, channelId, messageId] = match;
    return { guildId, channelId, messageId: messageId ?? null };
}

/** The channel id a `<#id>` mention or a link names, or null for anything else (a #name is matched against channels, not parsed). */
export function channelIdFromReference(text: string): string | null {
    const trimmed = text.trim();
    return /^<#(\d+)>$/.exec(trimmed)?.[1] ?? parseMessageLink(trimmed)?.channelId ?? null;
}
