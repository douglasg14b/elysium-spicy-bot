/**
 * One piece of copy on the stage. In Edit, as written, each `{{token}}` set apart so it reads
 * as something the run fills in; in Preview, each token replaced by the builder's stand-in
 * (`previewCopy`), a ping shown the way Discord shows one. In both, a role mention (`<@&id>`) in a
 * part where Discord shows one is drawn as Discord draws it: `@Role name`, in the role's colour.
 */

import { Fragment, type ReactNode } from 'react';
import { previewCopy } from '../copyPreview';
import { TOKEN_PATTERN } from '../variables';
import { DISCORD } from './discordLook';
import { ROLE_MENTION_PATTERN, roleMentionLabel, roleMentionStyle, type MentionableRole } from './roleMentions';

type Segment =
    | { readonly kind: 'text' | 'token'; readonly text: string }
    | { readonly kind: 'role'; readonly text: string; readonly roleId: string };

/** A token or, where `withRoles`, a role mention — whichever comes first. */
const TOKEN_OR_ROLE = new RegExp(`${TOKEN_PATTERN.source}|${ROLE_MENTION_PATTERN.source}`, 'g');

/**
 * A mention in Preview, as Discord draws it. In Edit it stays the text box's size and weight
 * (`RoleMark`), so clicking a part open does not shift its words.
 */
const DISCORD_PILL = { padding: '0 2px', fontWeight: 500 } as const;

/** `copy` cut into its plain text, its tokens and — where `withRoles` — its role mentions, in order. */
export function segmentsOf(copy: string, withRoles: boolean): Segment[] {
    const segments: Segment[] = [];
    let at = 0;
    for (const match of copy.matchAll(withRoles ? TOKEN_OR_ROLE : TOKEN_PATTERN)) {
        const start = match.index ?? 0;
        if (start > at) segments.push({ kind: 'text', text: copy.slice(at, start) });
        // The role id is the second capture: the first is the token's contents.
        const roleId = match[2];
        segments.push(roleId === undefined ? { kind: 'token', text: match[0] } : { kind: 'role', text: match[0], roleId });
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
    /**
     * The server's roles, for a part where Discord shows `<@&id>` as the role; absent where it
     * shows it as written, so it is drawn as written.
     */
    readonly roles?: readonly MentionableRole[];
}

export function CopyText({ text, preview, knownVariables, roles }: CopyTextProps) {
    return (
        <>
            {segmentsOf(text, roles !== undefined).map((segment, index): ReactNode => {
                switch (segment.kind) {
                    case 'text':
                        return <Fragment key={index}>{segment.text}</Fragment>;
                    case 'role':
                        return (
                            <span
                                key={index}
                                title={segment.text}
                                style={{ ...roleMentionStyle(segment.roleId, roles ?? []), ...(preview ? DISCORD_PILL : null) }}
                            >
                                {roleMentionLabel(segment.roleId, roles ?? [])}
                            </span>
                        );
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
