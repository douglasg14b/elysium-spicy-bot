import { MESSAGE_LIMITS } from '../../../shared/discordMessage';

/** Discord's limit on one message's content. */
export const DISCORD_MESSAGE_LIMIT = MESSAGE_LIMITS.content;

/** A reply never runs past this many messages; anything longer is cut at the last one. */
export const MAX_REPLY_PARTS = 2;

/**
 * The model's text as Discord message contents: control characters and zero-width
 * spaces removed, then split on paragraph, line, sentence or word boundaries — the
 * latest one that fits — into at most {@link MAX_REPLY_PARTS} parts.
 *
 * Returns an empty list for text with nothing left in it, so the caller decides what an
 * empty answer means rather than posting a blank.
 *
 * Pings are not this function's concern: the send sets `allowedMentions`, which is the
 * only thing that reliably stops `@everyone` (an escaped one still reads as a ping).
 */
export function toReplyParts(text: string): string[] {
    const cleaned = text
        .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
        .replace(/\u200B/g, '')
        .trim();

    const parts: string[] = [];
    let rest = cleaned;
    while (rest.length > 0 && parts.length < MAX_REPLY_PARTS) {
        if (rest.length <= DISCORD_MESSAGE_LIMIT) {
            parts.push(rest);
            break;
        }
        const isLastPart = parts.length === MAX_REPLY_PARTS - 1;
        const room = isLastPart ? DISCORD_MESSAGE_LIMIT - TRUNCATION_MARK.length : DISCORD_MESSAGE_LIMIT;
        const cut = lastBoundaryWithin(rest, room);
        const head = rest.slice(0, cut).trimEnd();
        parts.push(isLastPart ? `${head}${TRUNCATION_MARK}` : head);
        rest = rest.slice(cut).trimStart();
    }
    return parts;
}

const TRUNCATION_MARK = ' …';

/** Boundaries tried in order of preference; each pattern's match ends where a cut may go. */
const BOUNDARIES: readonly RegExp[] = [/\n\n/g, /\n/g, /[.!?…]\s/g, /\s/g];

/** Where to cut `text` so the head fits in `room`: the last good boundary, else a hard cut. */
function lastBoundaryWithin(text: string, room: number): number {
    const window = text.slice(0, room);
    for (const boundary of BOUNDARIES) {
        let lastEnd = -1;
        for (const match of window.matchAll(boundary)) {
            lastEnd = (match.index ?? 0) + match[0].length;
        }
        // A boundary in the first half would leave a stub of a first message.
        if (lastEnd > room / 2) return lastEnd;
    }
    return room;
}
