/**
 * A message button's emoji as the dashboard draws and names it, and what a sentence calls the
 * button — pure, so the root's drift test can hold {@link buttonDisplayName} to the server's.
 *
 * A standard emoji is its glyph (`{ name: '🌶️' }`); one of the server's own carries its id and
 * whether it moves (`{ id, name: 'blobheart', animated: false }`), and is drawn from Discord's
 * CDN, as Discord draws it.
 */

import type { GuildEmoji, MessageButton, MessageButtonEmoji } from '@brattybot/web-sdk';

/**
 * How an emoji reads in a sentence: a standard one as its glyph, a server one as `:name:`.
 * The server's `emojiText`, line for line.
 */
export function emojiText(emoji: MessageButtonEmoji): string {
    return emoji.id ? `:${emoji.name}:` : emoji.name;
}

/**
 * What the dashboard calls a button in text — the trigger's button picker, a face's accessible
 * name: its label, else its emoji ({@link emojiText}), else its key.
 * The server's `buttonDisplayName` (`src/features/provisioning/logic/messageButtons.ts`), held
 * to it by `buttonDisplayNameDrift.test.ts`, so a button reads the same here as in a refusal.
 */
export function buttonDisplayName(button: Pick<MessageButton, 'key' | 'label' | 'emoji'>): string {
    if (button.label) return button.label;
    if (button.emoji) return emojiText(button.emoji);
    return button.key;
}

/**
 * A button's face as text, where no picture can be drawn — the Button Click card: its emoji
 * ({@link emojiText}) before its label, as Discord sets them, else whichever it has. A face, not
 * a name: a sentence naming the button uses {@link buttonDisplayName}.
 */
export function buttonFaceText(button: Pick<MessageButton, 'key' | 'label' | 'emoji'>): string {
    if (button.emoji && button.label) return `${emojiText(button.emoji)} ${button.label}`;
    return buttonDisplayName(button);
}

/**
 * Where a server emoji's picture is: Discord's CDN, a GIF when it moves, at `size` pixels
 * (Discord serves powers of two; 48 is crisp at a button's 18 on a high-density screen).
 */
export function serverEmojiImageUrl(emoji: Pick<GuildEmoji, 'id' | 'animated'>, size: number): string {
    return `https://cdn.discordapp.com/emojis/${emoji.id}.${emoji.animated ? 'gif' : 'webp'}?size=${size}`;
}

/**
 * Whether a button's server emoji is no longer one of the server's — so install will post the
 * button without it. Only once the server's list has been read: `undefined` (still on its way,
 * or the read failed) says nothing is gone, rather than everything.
 */
export function isEmojiGone(emoji: MessageButtonEmoji, serverEmojis: readonly GuildEmoji[] | undefined): boolean {
    if (!emoji.id || !serverEmojis) return false;
    return !serverEmojis.some((candidate) => candidate.id === emoji.id);
}
