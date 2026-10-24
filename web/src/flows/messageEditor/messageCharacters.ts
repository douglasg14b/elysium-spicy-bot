/**
 * How much of Discord's 6000-character budget a message spends, for the window's meter.
 *
 * The one rule spanning parts that the browser shows, so it cannot come from the spec: a
 * part's own limit travels in `zDiscordMessage`, but a total across every embed is not a
 * rule any one part carries. A mirror of `MESSAGE_LIMITS.totalCharacters` and of
 * `messageCharacterCount(message, 'outsideTokens')` in `src/shared/discordMessage/`,
 * hand-written because nothing under `web/src` may import the bot's tree;
 * `src/shared/discordMessage/__tests__/messageMeterDrift.test.ts` holds the two together.
 *
 * Counted as a save judges it — only the text outside `{{tokens}}` — so the meter never
 * reads over when a save would not refuse. What a token becomes is only known once a run
 * fills it in, and the run judges the total again then.
 */

import type { DiscordMessage } from '@brattybot/web-sdk';
import { TOKEN_PATTERN } from '../variables';

/** Discord's limit on every embed's text in one message, counted together. */
export const MESSAGE_TOTAL_CHARACTERS = 6000;

/** One part's characters outside its tokens; nothing for a part left out. */
function lengthOutsideTokens(text: string | undefined): number {
    return text ? text.replace(TOKEN_PATTERN, '').length : 0;
}

/**
 * The characters a message spends against {@link MESSAGE_TOTAL_CHARACTERS}: every embed's
 * title, body, field headings and text, footer text and header text — Discord's rule. The
 * plain text above the embeds is not counted, and neither are links or pictures.
 */
export function messageCharacterCount(message: DiscordMessage): number {
    return message.embeds.reduce(
        (total, embed) =>
            total +
            lengthOutsideTokens(embed.title) +
            lengthOutsideTokens(embed.description) +
            (embed.fields ?? []).reduce(
                (fieldTotal, field) => fieldTotal + lengthOutsideTokens(field.name) + lengthOutsideTokens(field.value),
                0
            ) +
            lengthOutsideTokens(embed.footer?.text) +
            lengthOutsideTokens(embed.author?.name),
        0
    );
}
