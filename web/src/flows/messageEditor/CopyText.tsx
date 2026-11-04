/**
 * One piece of copy on the stage. In Edit, as written, each `{{token}}` set apart so it reads
 * as something the run fills in; in Preview, each token replaced by the builder's stand-in
 * (`previewCopy`), a ping shown the way Discord shows one. In both, a mention in a part where
 * Discord shows one is drawn as Discord draws it: a role (`<@&id>`) as `@Role name` in the
 * role's colour, a channel (`<#id>`) as `#channel-name` in the mention blurple, an emoji
 * (`<:name:id>`) as its picture.
 */

import { Fragment, type ReactNode } from 'react';
import { previewCopy } from '../copyPreview';
import { DISCORD } from './discordLook';
import { EmojiImage } from './EmojiImage';
import { mentionLook, segmentsOf, type MentionLists } from './mentions';

/**
 * A mention in Preview, as Discord draws it. In Edit it stays the text box's size and weight
 * (the box's own marks), so clicking a part open does not shift its words.
 */
const DISCORD_PILL = { padding: '0 2px', fontWeight: 500 } as const;

const TOKEN_STYLE = {
    fontFamily: 'var(--mantine-font-family-monospace)',
    fontSize: '0.85em',
    color: 'var(--mantine-color-brand-4)',
    background: 'rgba(0,162,255,.12)',
    borderRadius: 4,
    padding: '0 3px',
} as const;

const MENTION_STYLE = { ...DISCORD.mention, borderRadius: 3, padding: '0 2px' } as const;

/** Lists for the type's sake alone: a mention is only ever cut out of copy when lists were given. */
const NO_MENTIONS: MentionLists = { roles: [], channels: [], emojis: [] };

interface CopyTextProps {
    readonly text: string;
    readonly preview: boolean;
    /** Variables some upstream block writes, by name, for the preview's stand-ins. */
    readonly knownVariables: readonly string[];
    /**
     * The server's roles and text channels, for a part where Discord shows `<@&id>` and `<#id>`
     * as what they name; absent where it shows them as written, so they are drawn as written.
     */
    readonly mentions?: MentionLists;
}

export function CopyText({ text, preview, knownVariables, mentions }: CopyTextProps) {
    return (
        <>
            {segmentsOf(text, mentions !== undefined).map((segment, index): ReactNode => {
                switch (segment.kind) {
                    case 'text':
                        return <Fragment key={index}>{segment.text}</Fragment>;
                    case 'role':
                    case 'channel': {
                        const { label, style } = mentionLook(segment, mentions ?? NO_MENTIONS);
                        return (
                            <span key={index} title={segment.text} style={{ ...style, ...(preview ? DISCORD_PILL : null) }}>
                                {label}
                            </span>
                        );
                    }
                    case 'emoji':
                        return <EmojiImage key={index} id={segment.id} name={segment.name} animated={segment.animated} />;
                    case 'token': {
                        if (!preview) {
                            return (
                                <span key={index} style={TOKEN_STYLE}>
                                    {segment.text}
                                </span>
                            );
                        }
                        const shown = previewCopy(segment.text, knownVariables).text;
                        return shown.startsWith('@') ? (
                            <span key={index} style={MENTION_STYLE}>
                                {shown}
                            </span>
                        ) : (
                            <Fragment key={index}>{shown}</Fragment>
                        );
                    }
                    default: {
                        const illegal: never = segment;
                        throw new Error(`Unknown copy segment ${JSON.stringify(illegal)}.`);
                    }
                }
            })}
        </>
    );
}
