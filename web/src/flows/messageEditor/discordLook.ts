/**
 * Discord's own surfaces and type, so the window's stage reads as Discord rather than as the
 * dashboard — and the stage's few fixed measures. Only the stage uses these; the window
 * around it is the app theme.
 */

import type { CSSProperties } from 'react';
import type { MessageButtonStyle } from '@brattybot/web-sdk';
import type { TextPart } from './messageDraft';

export const DISCORD = {
    background: '#313338',
    embed: '#2b2d31',
    text: '#dbdee1',
    muted: '#949ba4',
    link: '#00a8fc',
    heading: '#ffffff',
    /** The edge of a pill that is off. (A part's hover edge is the same grey, in `messageEditor.css`.) */
    outline: '#4e5058',
    /** The dashed edge of an empty picture. */
    placeholderEdge: '#6d6f78',
    /** An embed with no colour picked. */
    embedGrey: '#4E5058',
    appBadge: '#5865f2',
    mention: { background: 'rgba(88,101,242,.3)', color: '#c9cdfb' },
} as const;

/** How each text part is set on the stage. */
export const PART_TYPE = {
    content: { fontSize: 15, lineHeight: 1.4, color: DISCORD.text },
    authorName: { fontSize: 14, fontWeight: 600, color: DISCORD.heading },
    title: { fontSize: 16, fontWeight: 700, color: DISCORD.heading },
    url: { fontSize: 12, color: DISCORD.link },
    description: { fontSize: 14, lineHeight: 1.4, color: DISCORD.text },
    fieldName: { fontSize: 14, fontWeight: 600, color: DISCORD.heading },
    fieldValue: { fontSize: 14, lineHeight: 1.4, color: DISCORD.text },
    footerText: { fontSize: 12, color: DISCORD.muted },
} as const satisfies Record<TextPart['kind'], CSSProperties>;

/** The width of each tool column beside an embed. */
export const TOOL_COLUMN = 34;

/**
 * Discord's own colour for each button style, and what the dashboard calls it — for the message
 * window's button row and the Button Click trigger's picker, which draw the same buttons.
 */
export const BUTTON_STYLES: Readonly<Record<MessageButtonStyle, { readonly colour: string; readonly name: string }>> = {
    Primary: { colour: '#5865f2', name: 'Blurple' },
    Secondary: { colour: '#4e5058', name: 'Grey' },
    Success: { colour: '#248046', name: 'Green' },
    Danger: { colour: '#da373c', name: 'Red' },
};

/** The styles in the order a style picker offers them. */
export const BUTTON_STYLE_ORDER: readonly MessageButtonStyle[] = ['Primary', 'Secondary', 'Success', 'Danger'];

/**
 * A button's face as Discord draws it, less its colour: its emoji and label side by side
 * (`ButtonFaceContent`, which cuts a long label short), so an emoji-only one is near square.
 */
export const BUTTON_FACE: CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    fontSize: 14,
    fontWeight: 500,
    lineHeight: '18px',
    padding: '7px 16px',
    borderRadius: 4,
    color: '#fff',
    maxWidth: 240,
    overflow: 'hidden',
    whiteSpace: 'nowrap',
};

/** Discord's own clock, for the message's header and a footer showing when it went out. */
export function postedAtLabel(now: Date): string {
    return `Today at ${now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
}
