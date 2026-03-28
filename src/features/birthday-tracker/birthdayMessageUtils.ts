const MAX_DISCORD_MESSAGE_LENGTH = 2000;

function stripDiscordMentionTokens(text: string): string {
    return text
        .replace(/<@!?\d+>/g, '')
        .replace(/<@&\d+>/g, '')
        .replace(/<#\d+>/g, '');
}

function neutralizeLiteralEveryoneHere(text: string): string {
    return text.replace(/@everyone/gi, 'everyone').replace(/@here/gi, 'here');
}

/**
 * Single outbound pipeline for birthday announcement body text (AI, fallback, or empty):
 * strips Discord mention tokens, neutralizes literal @everyone/@here, enforces length, trims.
 */
export function finalizeBirthdayAnnouncementBody(text: string, maxLength = 500): string {
    const capped = Math.min(maxLength, MAX_DISCORD_MESSAGE_LENGTH);
    let result = neutralizeLiteralEveryoneHere(stripDiscordMentionTokens(text));
    if (result.length > capped) {
        result = result.slice(0, capped);
    }
    return result.trim();
}

/** Alias of {@link finalizeBirthdayAnnouncementBody} for backward compatibility. */
export function sanitizeBirthdayAnnouncementText(text: string, maxLength = 500): string {
    return finalizeBirthdayAnnouncementBody(text, maxLength);
}
