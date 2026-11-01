/**
 * A role or a channel named in a message's text, written the way Discord reads it — `<@&roleId>`,
 * `<#channelId>` — and drawn on the stage the way Discord draws it: `@Role name` in the role's
 * colour, `#channel-name` in Discord's mention blurple.
 *
 * Nothing new is stored: the text keeps Discord's own syntax, so the bot posts it as written.
 * Posted, a role mention never notifies the role — an embed never pings, and the plain text allows
 * only members to be (`allowedMentions: { parse: ['users'] }` on every posting block) — and a
 * channel mention never pings anybody.
 */

import type { CSSProperties } from 'react';
import type { GuildChannel, GuildRole, ManagedRole } from '@brattybot/web-sdk';
import { roleColorHex } from '../nodeMeta';
import { postableChannels } from '../resourceAdoption';
import { TOKEN_PATTERN } from '../variables';
import { DISCORD } from './discordLook';

/**
 * A role a message may name: one a flow may grant (`GuildRole`) or one Discord or an
 * integration manages (`ManagedRole`, Server Booster and the like) — a message names either.
 */
export type MentionableRole = Pick<GuildRole, 'id' | 'name' | 'color' | 'position'>;

/** A channel a message may name: a text channel, with the category it sits in as a hint. */
export type MentionableChannel = Pick<GuildChannel, 'id' | 'name' | 'parentName'>;

/** What a box or a part offering mentions offers, and what it draws `<@&id>` and `<#id>` from. */
export interface MentionLists {
    readonly roles: readonly MentionableRole[];
    readonly channels: readonly MentionableChannel[];
}

/**
 * The lists for a message: every role, the managed ones too — only the pickers that grant a role
 * leave those out — and the server's text channels, in the channel picker's order
 * (`postableChannels`, the order the server sends).
 */
export function mentionListsOf(
    roles: readonly GuildRole[],
    managedRoles: readonly ManagedRole[] | undefined,
    channels: readonly GuildChannel[]
): MentionLists {
    return { roles: [...roles, ...(managedRoles ?? [])], channels: postableChannels(channels) };
}

/** Discord's mention blurple: a channel's pill, and a role's when it has no colour. */
const BLURPLE_PILL: CSSProperties = { ...DISCORD.mention, borderRadius: 3 };

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
    if (!color) return BLURPLE_PILL;
    const hex = roleColorHex(color);
    // `1a` is a tenth of full opacity: the faint wash Discord puts behind a coloured role.
    return { color: hex, background: `${hex}1a`, borderRadius: 3 };
}

/** A channel mention as `react-mentions` writes it: the id in Discord's own syntax. */
export const CHANNEL_MENTION_MARKUP = '<#__id__>';

/**
 * One `<#id>`, the id captured — read by the stage and the text box alike. Only digits:
 * `<#{{var.ticketChannelId}}>`, the channel link the token picker writes, stays a token.
 */
export const CHANNEL_MENTION_PATTERN = /<#(\d+)>/;

/** What a mention of a channel the list does not hold says — one deleted, not a text channel, or not loaded yet. */
export const UNKNOWN_CHANNEL_LABEL = '#unknown-channel';

/** `#channel-name` for a mentioned channel, or {@link UNKNOWN_CHANNEL_LABEL} when the list does not hold it. */
export function channelMentionLabel(channelId: string, channels: readonly MentionableChannel[]): string {
    const channel = channels.find((candidate) => candidate.id === channelId);
    return channel ? `#${channel.name}` : UNKNOWN_CHANNEL_LABEL;
}

/** A channel mention's pill — Discord's mention blurple, as for a role with no colour. */
export const CHANNEL_MENTION_STYLE: CSSProperties = BLURPLE_PILL;

/** A piece of copy: plain text, a `{{token}}`, or a role or channel mention. */
export type CopySegment =
    | { readonly kind: 'text' | 'token'; readonly text: string }
    | MentionSegment;

/** A mention cut out of copy, with the id it names. */
export type MentionSegment =
    | { readonly kind: 'role'; readonly text: string; readonly roleId: string }
    | { readonly kind: 'channel'; readonly text: string; readonly channelId: string };

/** A token or, where `withMentions`, a role or a channel mention — whichever comes first. */
const TOKEN_OR_MENTION = new RegExp(
    `${TOKEN_PATTERN.source}|${ROLE_MENTION_PATTERN.source}|${CHANNEL_MENTION_PATTERN.source}`,
    'g'
);

/**
 * `copy` cut into its plain text, its tokens and — where `withMentions` — its role and channel
 * mentions, in order. The one reading of copy for the stage (`CopyText`) and the inspector's
 * preview (`CopyPreview`) alike, so the two never disagree on what is a mention.
 */
export function segmentsOf(copy: string, withMentions: boolean): CopySegment[] {
    const segments: CopySegment[] = [];
    let at = 0;
    for (const match of copy.matchAll(withMentions ? TOKEN_OR_MENTION : TOKEN_PATTERN)) {
        const start = match.index ?? 0;
        if (start > at) segments.push({ kind: 'text', text: copy.slice(at, start) });
        // The first capture is the token's contents, the second a role's id, the third a channel's.
        const [text, , roleId, channelId] = match;
        segments.push(
            roleId !== undefined
                ? { kind: 'role', text, roleId }
                : channelId !== undefined
                  ? { kind: 'channel', text, channelId }
                  : { kind: 'token', text }
        );
        at = start + text.length;
    }
    if (at < copy.length) segments.push({ kind: 'text', text: copy.slice(at) });
    return segments;
}

/** How a mention is drawn: what it says, and its pill. */
export interface MentionLook {
    readonly label: string;
    readonly style: CSSProperties;
}

/** A mention's name and pill, from the lists — the one place a mention becomes what Discord shows. */
export function mentionLook(segment: MentionSegment, mentions: MentionLists): MentionLook {
    switch (segment.kind) {
        case 'role':
            return {
                label: roleMentionLabel(segment.roleId, mentions.roles),
                style: roleMentionStyle(segment.roleId, mentions.roles),
            };
        case 'channel':
            return { label: channelMentionLabel(segment.channelId, mentions.channels), style: CHANNEL_MENTION_STYLE };
        default: {
            const illegal: never = segment;
            throw new Error(`Unknown mention ${JSON.stringify(illegal)}.`);
        }
    }
}
