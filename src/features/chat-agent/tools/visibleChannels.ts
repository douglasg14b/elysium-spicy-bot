import { ChannelType, PermissionFlagsBits } from 'discord.js';
import type { Guild, GuildBasedChannel, GuildMember, GuildTextBasedChannel } from 'discord.js';

/**
 * Everyone who will read what the agent says this turn: the asker first, then every other
 * member who can see the channel the answer is posted in. An answer is public to the whole
 * channel, so what the agent may repeat is what **all** of them could see for themselves —
 * a moderator asking in `#general` must not get `#staff-notes` read out to everyone there.
 */
export type Viewers = readonly [asker: GuildMember, ...audience: GuildMember[]];

/** The viewers of an answer posted in `channel` to `asker`: the asker, then every other human member who can see it. */
export function viewersOf(channel: GuildTextBasedChannel, asker: GuildMember): Viewers {
    const audience = [...channel.guild.members.cache.values()].filter(
        (member) => member.id !== asker.id && !member.user.bot && memberCanSee(member, channel)
    );
    return [asker, ...audience];
}

/**
 * Whether `member` can see `channel`.
 *
 * A thread answers with its parent's permissions in discord.js, which is right for a
 * public thread and wrong for a private one: that takes membership, or Manage Threads.
 * No answer at all (an uncached parent) counts as cannot see.
 */
export function memberCanSee(member: GuildMember, channel: GuildBasedChannel): boolean {
    const permissions = channel.permissionsFor(member);
    if (!permissions?.has(PermissionFlagsBits.ViewChannel)) return false;
    if (channel.type === ChannelType.PrivateThread) {
        return channel.members.cache.has(member.id) || permissions.has(PermissionFlagsBits.ManageThreads);
    }
    return true;
}

/** Per set of viewers, what has been decided about each channel — a busy channel has many viewers, and a turn asks often. */
const decided = new WeakMap<Viewers, Map<string, boolean>>();

/**
 * Whether every one of `viewers` can see `channel` — the one rule every channel-revealing
 * tool goes through. Remembered per viewers set, so a turn pays for each channel once.
 */
export function everyoneCanSee(viewers: Viewers, channel: GuildBasedChannel): boolean {
    let known = decided.get(viewers);
    if (!known) {
        known = new Map();
        decided.set(viewers, known);
    }
    const remembered = known.get(channel.id);
    if (remembered !== undefined) return remembered;
    const answer = viewers.every((member) => memberCanSee(member, channel));
    known.set(channel.id, answer);
    return answer;
}

/**
 * Channels every viewer can see, in the server's own order. Categories and threads are
 * left out: categories are only labels, and threads come and go too fast to point anyone at.
 */
export function listVisibleChannels(viewers: Viewers): GuildBasedChannel[] {
    return [...viewers[0].guild.channels.cache.values()]
        .filter((channel) => channel.type !== ChannelType.GuildCategory && !channel.isThread())
        .filter((channel) => everyoneCanSee(viewers, channel))
        .sort((left, right) => sortKey(left) - sortKey(right));
}

function sortKey(channel: GuildBasedChannel): number {
    const parentPosition = channel.parent?.position ?? -1;
    const ownPosition = 'position' in channel ? channel.position : 0;
    return parentPosition * 10_000 + ownPosition;
}

/**
 * A channel every viewer can see, by id, `<#id>`, or name (`#` optional, case-insensitive;
 * an exact name before a partial one). Undefined when nothing visible matches.
 */
export function findVisibleChannel(viewers: Viewers, query: string): GuildBasedChannel | undefined {
    return matchChannel(listVisibleChannels(viewers), query);
}

/**
 * The one of `candidates` that `query` names: by id, `<#id>`, or name (`#` optional,
 * case-insensitive; an exact name before a partial one). Undefined when none does.
 */
export function matchChannel<Channel extends { readonly id: string; readonly name: string }>(
    candidates: readonly Channel[],
    query: string
): Channel | undefined {
    const trimmed = query.trim();
    const id = /^<#(\d+)>$/.exec(trimmed)?.[1] ?? (/^\d{15,22}$/.test(trimmed) ? trimmed : undefined);
    if (id) return candidates.find((channel) => channel.id === id);

    const name = trimmed.replace(/^#/, '').toLowerCase();
    return (
        candidates.find((channel) => channel.name.toLowerCase() === name) ??
        candidates.find((channel) => channel.name.toLowerCase().includes(name))
    );
}

/** A text channel whose messages every viewer, and the bot, may read; else undefined. */
export function readableTextChannel(
    viewers: Viewers,
    channel: GuildBasedChannel | null | undefined
): GuildTextBasedChannel | undefined {
    if (!channel || !channel.isTextBased() || !everyoneCanSee(viewers, channel)) return undefined;
    if (!everyoneCanReadHistory(viewers, channel)) return undefined;
    return botCanRead(viewers[0].guild, channel) ? channel : undefined;
}

/** Whether every viewer may read `channel`'s history — a channel members can post in but not read back is not one to summarise. */
export function everyoneCanReadHistory(viewers: Viewers, channel: GuildBasedChannel): boolean {
    return viewers.every((member) => !!channel.permissionsFor(member)?.has(PermissionFlagsBits.ReadMessageHistory));
}

/** Whether the bot itself may read `channel`'s messages: View Channel and Read Message History. */
export function botCanRead(guild: Guild, channel: GuildBasedChannel): boolean {
    const me = guild.members.me;
    return !!me && !!channel.permissionsFor(me)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory]);
}
