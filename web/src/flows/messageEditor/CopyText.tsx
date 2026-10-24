/**
 * One piece of copy on the stage. In Edit, as written, each `{{token}}` set apart so it reads
 * as something the run fills in; in Preview, each token replaced by the builder's stand-in
 * (`previewCopy`), a ping shown the way Discord shows one.
 */

import { Fragment, type ReactNode } from 'react';
import { previewCopy } from '../copyPreview';
import { TOKEN_PATTERN } from '../variables';
import { DISCORD } from './discordLook';

type Segment = { readonly kind: 'text' | 'token'; readonly text: string };

/** `copy` cut into its plain text and its tokens, in order. */
function segmentsOf(copy: string): Segment[] {
    const segments: Segment[] = [];
    let at = 0;
    for (const match of copy.matchAll(TOKEN_PATTERN)) {
        const start = match.index ?? 0;
        if (start > at) segments.push({ kind: 'text', text: copy.slice(at, start) });
        segments.push({ kind: 'token', text: match[0] });
        at = start + match[0].length;
    }
    if (at < copy.length) segments.push({ kind: 'text', text: copy.slice(at) });
    return segments;
}

const TOKEN_STYLE = {
    fontFamily: 'var(--mantine-font-family-monospace)',
    fontSize: '0.85em',
    color: 'var(--mantine-color-brand-4)',
    background: 'rgba(0,162,255,.12)',
    borderRadius: 4,
    padding: '0 3px',
} as const;

const MENTION_STYLE = { ...DISCORD.mention, borderRadius: 3, padding: '0 2px' } as const;

interface CopyTextProps {
    readonly text: string;
    readonly preview: boolean;
    /** Variables some upstream block writes, by name, for the preview's stand-ins. */
    readonly knownVariables: readonly string[];
}

export function CopyText({ text, preview, knownVariables }: CopyTextProps) {
    return (
        <>
            {segmentsOf(text).map((segment, index): ReactNode => {
                if (segment.kind === 'text') return <Fragment key={index}>{segment.text}</Fragment>;
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
            })}
        </>
    );
}
