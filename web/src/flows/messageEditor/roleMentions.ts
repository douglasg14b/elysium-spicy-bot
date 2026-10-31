/**
 * A role named in a message's text, written the way Discord reads it — `<@&roleId>` — and drawn
 * on the stage the way Discord draws it: `@Role name`, in the role's colour.
 *
 * Nothing new is stored: the text keeps Discord's own syntax, so the bot posts it as written.
 * Posted, it never notifies the role — an embed never pings, and the plain text allows only
 * members to be (`allowedMentions: { parse: ['users'] }` on every posting block).
 */

import type { CSSProperties } from 'react';
import type { GuildRole } from '@brattybot/web-sdk';
import { roleColorHex } from '../nodeMeta';
import { DISCORD } from './discordLook';
import type { TextPart } from './messageDraft';

/**
 * A role a message may name: one a flow may grant (`GuildRole`) or one Discord or an
 * integration manages (`ManagedRole`, Server Booster and the like) — a message names either.
 */
export type MentionableRole = Pick<GuildRole, 'id' | 'name' | 'color' | 'position'>;

/** A role mention as `react-mentions` writes it: the id in Discord's own syntax. */
export const ROLE_MENTION_MARKUP = '<@&__id__>';

/**
 * One `<@&id>`, the id captured — read by the stage (`CopyText`) and the text box alike, so the
 * two never disagree on what is a mention. Only digits: `<@&{{var.roleId}}>` stays a token.
 */
export const ROLE_MENTION_PATTERN = /<@&(\d+)>/;

/** What a mention of a role the list does not hold says — one deleted, or not loaded yet. */
export const UNKNOWN_ROLE_LABEL = '@unknown-role';

/** `@Role name` for a mentioned role, or {@link UNKNOWN_ROLE_LABEL} when the list does not hold it. */
export function roleMentionLabel(roleId: string, roles: readonly MentionableRole[]): string {
    const role = roles.find((candidate) => candidate.id === roleId);
    return role ? `@${role.name}` : UNKNOWN_ROLE_LABEL;
}

/**
 * A role mention's pill: Discord's mention blurple for a role with no colour (or one not in the
 * list), else the role's colour as text over a faint wash of it.
 */
export function roleMentionStyle(roleId: string, roles: readonly MentionableRole[]): CSSProperties {
    const color = roles.find((candidate) => candidate.id === roleId)?.color ?? 0;
    if (!color) return { ...DISCORD.mention, borderRadius: 3 };
    const hex = roleColorHex(color);
    // `1a` is a tenth of full opacity: the faint wash Discord puts behind a coloured role.
    return { color: hex, background: `${hex}1a`, borderRadius: 3 };
}

/**
 * Whether Discord shows `<@&id>` in this part as the role: in the plain text, an embed's
 * description and a field's text. A header, title, link, field heading or footer shows the
 * `<@&…>` as written, so none of them offers the `@` picker or draws a pill.
 */
export function showsRoleMentions(part: TextPart): boolean {
    switch (part.kind) {
        case 'content':
        case 'description':
        case 'fieldValue':
            return true;
        case 'authorName':
        case 'title':
        case 'url':
        case 'footerText':
        case 'fieldName':
            return false;
        default: {
            const illegal: never = part;
            throw new Error(`Unknown text part ${JSON.stringify(illegal)}.`);
        }
    }
}
