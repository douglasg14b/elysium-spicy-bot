const MAX_DISCORD_MESSAGE_LENGTH = 2000;

/**
 * Strip risky mass-mentions and cap length for outbound birthday announcement text.
 */
export function sanitizeBirthdayAnnouncementText(text: string, maxLength = 500): string {
    const capped = Math.min(maxLength, MAX_DISCORD_MESSAGE_LENGTH);
    let result = text.replace(/@everyone/gi, 'everyone').replace(/@here/gi, 'here');
    if (result.length > capped) {
        result = result.slice(0, capped);
    }
    return result.trim();
}
