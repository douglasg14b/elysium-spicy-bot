/**
 * What a button shows on its face — its emoji, then its label — wherever the dashboard draws
 * one: the message window's row, the Button Click trigger's picker, and the emoji field's
 * square. The colour, size and padding are the caller's (`BUTTON_FACE`).
 */

import { useState, type CSSProperties } from 'react';
import type { MessageButton, MessageButtonEmoji } from '@brattybot/web-sdk';
import { emojiText, serverEmojiImageUrl } from '../buttonEmoji';

/** The label beside the emoji: cut short with an ellipsis, which a flex face cannot do itself. */
const FACE_LABEL: CSSProperties = { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' };

interface EmojiGlyphProps {
    readonly emoji: MessageButtonEmoji;
    /** Its height in pixels. */
    readonly size: number;
}

/**
 * One emoji, `size` pixels high: a standard one as the device's own glyph, a server one as its
 * picture from Discord, named `:name:` for a reader that cannot see it.
 *
 * A picture Discord won't serve — the emoji deleted from the server, most often — draws as its
 * `:name:` rather than a broken picture.
 */
export function EmojiGlyph({ emoji, size }: EmojiGlyphProps) {
    // The id whose picture failed, not a flag: picking another emoji gets its own try.
    const [unservedId, setUnservedId] = useState<string>();
    if (emoji.id && emoji.id === unservedId) {
        return <span style={{ ...FACE_LABEL, flex: 'none', opacity: 0.7 }}>{emojiText(emoji)}</span>;
    }
    if (emoji.id) {
        return (
            <img
                src={serverEmojiImageUrl({ id: emoji.id, animated: emoji.animated === true }, 48)}
                alt={emojiText(emoji)}
                referrerPolicy="no-referrer"
                onError={() => setUnservedId(emoji.id)}
                style={{ width: size, height: size, objectFit: 'contain', flex: 'none', display: 'block' }}
            />
        );
    }
    return <span style={{ fontSize: size, lineHeight: 1, flex: 'none' }}>{emoji.name}</span>;
}

interface ButtonFaceContentProps {
    readonly button: Pick<MessageButton, 'label' | 'emoji'>;
    /** The emoji's height: a face's text height or a little over, as Discord sets it. */
    readonly emojiSize: number;
}

/** A face's emoji and label, in Discord's order. A button with neither — refused at save — draws empty. */
export function ButtonFaceContent({ button, emojiSize }: ButtonFaceContentProps) {
    return (
        <>
            {button.emoji ? <EmojiGlyph emoji={button.emoji} size={emojiSize} /> : null}
            {button.label ? <span style={FACE_LABEL}>{button.label}</span> : null}
            {!button.label && !button.emoji ? ' ' : null}
        </>
    );
}
