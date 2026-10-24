/**
 * Reads a `message` field's stored value for display — the inspector's preview and the
 * node card's one line both read it here, so they cannot disagree about what is in it.
 */

import type { DiscordMessage } from '@brattybot/web-sdk';
import { readMessageDraft } from './messageEditor/messageDraft';

/** The parts of one embed the dashboard shows without opening it. */
export type StoredEmbed = Pick<DiscordMessage['embeds'][number], 'title' | 'description' | 'color'>;

/** A stored message's plain text and each embed's headline parts; `content` is `''` when unset. */
export interface StoredMessage {
    readonly content: string;
    readonly embeds: readonly StoredEmbed[];
}

/** A part with something in it, trimmed, or nothing for a part that is blank. */
function shown(text: string | undefined): string | undefined {
    return text?.trim() || undefined;
}

/**
 * Read a stored value whatever shape it is in, as the message window reads it
 * (`readMessageDraft`): a value that is not an object reads as an empty message, and a part
 * of the wrong type is left out — the server's re-check is what says what is wrong with it.
 * Only what has something to show is kept: a blank part is as good as none here.
 */
export function readStoredMessage(raw: unknown): StoredMessage {
    const message = readMessageDraft(raw) ?? { embeds: [] };
    return {
        content: shown(message.content) ?? '',
        embeds: message.embeds.map((embed): StoredEmbed => {
            const title = shown(embed.title);
            const description = shown(embed.description);
            const color = shown(embed.color);
            return {
                ...(title ? { title } : {}),
                ...(description ? { description } : {}),
                ...(color ? { color } : {}),
            };
        }),
    };
}
