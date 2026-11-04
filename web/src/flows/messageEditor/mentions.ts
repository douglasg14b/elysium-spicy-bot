/**
 * A role, a channel or one of the server's emoji named in a message's text, written the way
 * Discord reads it — `<@&roleId>`, `<#channelId>`, `<:name:emojiId>` (`<a:name:emojiId>` for a
 * moving one) — and drawn on the stage the way Discord draws it: `@Role name` in the role's
 * colour, `#channel-name` in Discord's mention blurple, an emoji as its picture.
 *
 * Nothing new is stored: the text keeps Discord's own syntax, so the bot posts it as written.
 * Posted, a role mention never notifies the role — an embed never pings, and the plain text allows
 * only members to be (`allowedMentions: { parse: ['users'] }` on every posting block) — and a
 * channel mention never pings anybody.
 *
 * An emoji needs its id to be posted: Discord's own app turns a typed `:name:` into
 * `<:name:id>` before it sends, but the API does not, so the bot posts `:name:` as plain text.
 * The text box offers the server's emoji on `:`, and turns a complete `:name:` it knows
 * ({@link withKnownEmojis}) into the posted form.
 */

import type { CSSProperties } from 'react';
import type { GuildChannel, GuildEmoji, GuildRole, ManagedRole } from '@brattybot/web-sdk';
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

/** An emoji a message may show: one of the server's own. */
export type MentionableEmoji = Pick<GuildEmoji, 'id' | 'name' | 'animated'>;

/** What a box or a part offering mentions offers, and what it draws `<@&id>`, `<#id>` and `<:name:id>` from. */
export interface MentionLists {
    readonly roles: readonly MentionableRole[];
    readonly channels: readonly MentionableChannel[];
    readonly emojis: readonly MentionableEmoji[];
}

/**
 * The lists for a message: every role, the managed ones too — only the pickers that grant a role
 * leave those out — the server's text channels, in the channel picker's order
 * (`postableChannels`, the order the server sends), and its emoji. `serverEmojis` is `undefined`
 * while the read is on its way or after it failed: no emoji is offered, and any in the text are
 * still drawn, from their ids.
 */
export function mentionListsOf(
    roles: readonly GuildRole[],
    managedRoles: readonly ManagedRole[] | undefined,
    channels: readonly GuildChannel[],
    serverEmojis: readonly GuildEmoji[] | undefined
): MentionLists {
    return {
        roles: [...roles, ...(managedRoles ?? [])],
        channels: postableChannels(channels),
        emojis: serverEmojis ?? [],
    };
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

/**
 * An emoji as `react-mentions` writes it: the whole of Discord's own syntax is its "id" —
 * `:name:123`, or `a:name:123` for a moving one — since the library takes one id per mention
 * and the posted text needs all three parts.
 */
export const EMOJI_MENTION_MARKUP = '<__id__>';

/**
 * One `<:name:id>` or `<a:name:id>`, the text between the brackets captured (the library takes
 * exactly one capture) — read by the stage and the text box alike. A name is Discord's own rule,
 * 2 to 32 letters, digits and underscores, so `<:{{var.x}}:123>` stays a token.
 */
export const EMOJI_MENTION_PATTERN = /<(a?:\w{2,32}:\d+)>/;

/** An emoji named in copy: its picture's id, its name, and whether it moves. */
export interface EmojiReference {
    readonly id: string;
    readonly name: string;
    readonly animated: boolean;
}

/** The emoji a capture of {@link EMOJI_MENTION_PATTERN} names (`a:name:123`, or `:name:123`). */
export function parseEmojiReference(captured: string): EmojiReference {
    const [prefix = '', name = '', id = ''] = captured.split(':');
    return { id, name, animated: prefix === 'a' };
}

/** An emoji as it is written in the text — the `a:name:123` {@link EMOJI_MENTION_MARKUP} takes for its id. */
export function emojiMentionId(emoji: MentionableEmoji): string {
    return `${emoji.animated ? 'a' : ''}:${emoji.name}:${emoji.id}`;
}

/** An existing `<:name:id>` — kept whole — or a bare `:name:` that might be an emoji typed or pasted. */
const WRITTEN_OR_BARE_EMOJI = /<a?:\w{2,32}:\d+>|:(\w{2,32}):/g;

/**
 * `text` with each complete `:name:` that names one of the server's emoji written as the emoji —
 * what Discord's own app does as the closing colon is typed, and what a paste of text copied from
 * Discord needs. The box shows an emoji as `:name:` either way, so the text on screen — and the
 * caret in it — does not move. A `:name:` the server has no emoji for stays as typed.
 */
export function withKnownEmojis(text: string, emojis: readonly MentionableEmoji[]): string {
    if (emojis.length === 0) return text;
    return text.replace(WRITTEN_OR_BARE_EMOJI, (written, name: string | undefined) => {
        if (name === undefined) return written;
        const emoji = emojis.find((candidate) => candidate.name === name);
        return emoji ? `<${emojiMentionId(emoji)}>` : written;
    });
}

/** A piece of copy: plain text, a `{{token}}`, or a role, channel or emoji mention. */
export type CopySegment =
    | { readonly kind: 'text' | 'token'; readonly text: string }
    | MentionSegment
    | EmojiSegment;

/** An emoji cut out of copy. */
export type EmojiSegment = { readonly kind: 'emoji'; readonly text: string } & EmojiReference;

/** A mention cut out of copy, with the id it names. */
export type MentionSegment =
    | { readonly kind: 'role'; readonly text: string; readonly roleId: string }
    | { readonly kind: 'channel'; readonly text: string; readonly channelId: string };

/** A token or, where `withMentions`, a role, channel or emoji mention — whichever comes first. */
const TOKEN_OR_MENTION = new RegExp(
    `${TOKEN_PATTERN.source}|${ROLE_MENTION_PATTERN.source}|${CHANNEL_MENTION_PATTERN.source}|${EMOJI_MENTION_PATTERN.source}`,
    'g'
);

/**
 * `copy` cut into its plain text, its tokens and — where `withMentions` — its role, channel and
 * emoji mentions, in order. The one reading of copy for the stage (`CopyText`) and the inspector's
 * preview (`CopyPreview`) alike, so the two never disagree on what is a mention.
 */
export function segmentsOf(copy: string, withMentions: boolean): CopySegment[] {
    const segments: CopySegment[] = [];
    let at = 0;
    for (const match of copy.matchAll(withMentions ? TOKEN_OR_MENTION : TOKEN_PATTERN)) {
        const start = match.index ?? 0;
        if (start > at) segments.push({ kind: 'text', text: copy.slice(at, start) });
        // The first capture is the token's contents, then a role's id, a channel's, and an emoji's.
        const [text, , roleId, channelId, emojiCapture] = match;
        segments.push(
            roleId !== undefined
                ? { kind: 'role', text, roleId }
                : channelId !== undefined
                  ? { kind: 'channel', text, channelId }
                  : emojiCapture !== undefined
                    ? { kind: 'emoji', text, ...parseEmojiReference(emojiCapture) }
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
