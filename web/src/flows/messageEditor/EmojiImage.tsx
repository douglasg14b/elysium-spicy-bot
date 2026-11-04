/**
 * A server emoji named in a message's text, drawn as Discord draws it: its picture, inline, a
 * little taller than the line's text. Drawn from its id alone, so one the server no longer has
 * (or whose list has not loaded) shows its `:name:` where the picture would have been.
 */

import { serverEmojiImageUrl } from '../buttonEmoji';
import type { EmojiReference } from './mentions';

/** Discord's inline emoji size, in the text's own units. */
const INLINE_SIZE = '1.375em';

interface EmojiImageProps extends EmojiReference {
    /** Beside its own `:name:` in words, which already names it: the picture says nothing more. */
    readonly decorative?: boolean;
}

export function EmojiImage({ id, name, animated, decorative = false }: EmojiImageProps) {
    return (
        <img
            src={serverEmojiImageUrl({ id, animated }, 48)}
            alt={decorative ? '' : `:${name}:`}
            title={decorative ? undefined : `:${name}:`}
            draggable={false}
            style={{ height: INLINE_SIZE, width: 'auto', verticalAlign: '-0.3em' }}
        />
    );
}
