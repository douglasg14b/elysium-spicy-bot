/**
 * The searchable emoji grid a button's emoji is picked from: emoji-picker-react, set up the
 * way Discord's own picker reads — dark, the server's own emoji first under "This server",
 * then every standard one.
 *
 * Its own module so the package (its code and its emoji data) loads only when someone first
 * opens a grid: `ButtonEmojiField` imports this lazily, and nothing else may import it.
 */

import { useMemo } from 'react';
import EmojiPicker, { Categories, EmojiStyle, type CustomEmoji, type EmojiClickData } from 'emoji-picker-react';
import type { GuildEmoji, MessageButtonEmoji } from '@brattybot/web-sdk';
import { serverEmojiImageUrl } from '../buttonEmoji';

/**
 * The newest Unicode emoji version offered. Discord draws standard emoji with its own set,
 * which trails Unicode; an emoji newer than it shows as a blank box on the button, or is
 * refused. 15.0 is a release Discord has long drawn.
 */
const EMOJI_VERSION = '15.0';

/** Every section, the server's own first after the recently used — Discord's order. */
const CATEGORIES = [
    Categories.SUGGESTED,
    { category: Categories.CUSTOM, name: 'This server' },
    Categories.SMILEYS_PEOPLE,
    Categories.ANIMALS_NATURE,
    Categories.FOOD_DRINK,
    Categories.TRAVEL_PLACES,
    Categories.ACTIVITIES,
    Categories.OBJECTS,
    Categories.SYMBOLS,
    Categories.FLAGS,
];

const NO_SERVER_EMOJIS: readonly GuildEmoji[] = [];

/**
 * The emoji a click picked, as a button stores it: a standard one as its glyph alone — skin
 * tone and all — and one of the server's as its id, name and whether it moves, read from the
 * server's list rather than the grid's copy. `animated` is always written for a server emoji
 * and never for a standard one: the message's digest hashes what is sent, so `false` and
 * absent would read as two different buttons.
 *
 * `undefined` for a server emoji the list no longer holds — the grid was drawn from an older
 * list — rather than a guess at it.
 */
export function pickedEmoji(clicked: EmojiClickData, serverEmojis: readonly GuildEmoji[]): MessageButtonEmoji | undefined {
    if (!clicked.isCustom) return { name: clicked.emoji };
    // A server emoji's `unified` is its id, lowercased — an id is digits, so unchanged.
    const picked = serverEmojis.find((emoji) => emoji.id === clicked.unified);
    return picked ? { id: picked.id, name: picked.name, animated: picked.animated } : undefined;
}

interface EmojiGridProps {
    /** The server's own emoji; `undefined` (not read yet, or the read failed) offers only the standard ones. */
    readonly serverEmojis: readonly GuildEmoji[] | undefined;
    readonly onPick: (emoji: MessageButtonEmoji) => void;
}

export function EmojiGrid({ serverEmojis = NO_SERVER_EMOJIS, onPick }: EmojiGridProps) {
    // One array per list: the grid caches the server's section by the array it is handed.
    const customEmojis = useMemo<CustomEmoji[]>(
        () => serverEmojis.map((emoji) => ({ id: emoji.id, names: [emoji.name], imgUrl: serverEmojiImageUrl(emoji, 48) })),
        [serverEmojis]
    );

    return (
        <EmojiPicker
            colorScheme="dark"
            // The device's own glyphs: nothing standard is fetched from a CDN.
            emojiStyle={EmojiStyle.NATIVE}
            emojiVersion={EMOJI_VERSION}
            lazyLoadEmojis
            categories={CATEGORIES}
            customEmojis={customEmojis}
            previewConfig={{ showPreview: false }}
            labels={{ searchPlaceholder: 'Hunt for an emoji…' }}
            width={300}
            height={360}
            onEmojiClick={(clicked) => {
                const picked = pickedEmoji(clicked, serverEmojis);
                if (picked) onPick(picked);
            }}
        />
    );
}
