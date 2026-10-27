import {
    ChannelType,
    ComponentType,
    MessageFlags,
    PermissionFlagsBits,
    type Guild,
    type GuildBasedChannel,
    type Message,
    type NewsChannel,
    type TextChannel,
} from 'discord.js';
import type { ResourceBindingEntity } from '../data/resourceBindingsSchema';
import { DISCORD_UNKNOWN_CHANNEL, DISCORD_UNKNOWN_MESSAGE, describeDiscordError, discordErrorCode } from './discordErrors';
import { buttonDisplayName, parseMessageButtonCustomId } from './messageButtons';

/**
 * Whether a message a journey posted is still there, as every planner is handed it.
 *
 * `found` and `gone` are Discord's own answers. `unreadable` is everything else — a channel
 * the bot can no longer see, a timeout — with the reason in words an operator can act on
 * (`describeDiscordError`). A planner never turns it into either of the other two: a
 * message read as gone is posted again, and one read as found is never looked at again.
 * A planner settles `unreadable` first, then switches exhaustively on the other two.
 */
export type MessagePresence = 'found' | 'gone' | { readonly unreadable: string };

/** A `message` row that names a post: settled, with the message's id. The rows presence is read for. */
export function isPostedMessageRow(row: ResourceBindingEntity): row is ResourceBindingEntity & { readonly discordId: string } {
    return row.kind === 'message' && row.state !== 'intended' && !!row.discordId;
}

/**
 * A posted message's presence out of the map its service call read, or throw: a planner
 * handed no answer for a posted message was called without `readMessagePresence`, and
 * guessing either way would repost it or forget it.
 *
 * @param planned what was built without it, for the error: "its plan was built", say.
 */
export function requireMessagePresence(
    presence: ReadonlyMap<string, MessagePresence> | undefined,
    row: Pick<ResourceBindingEntity, 'ownerKey' | 'resourceKey'>,
    planned: string
): MessagePresence {
    const found = presence?.get(row.resourceKey);
    if (!found) {
        throw new Error(
            `Journey "${row.ownerKey}" posted the message "${row.resourceKey}", but ${planned} without checking whether it is still there.`
        );
    }
    return found;
}

/** What reading a message needs in its channel, beyond seeing the guild. */
const READ_MESSAGE_PERMISSIONS = [
    { flag: PermissionFlagsBits.ViewChannel, name: 'View Channel' },
    { flag: PermissionFlagsBits.ReadMessageHistory, name: 'Read Message History' },
] as const;

/**
 * A channel a journey's message can be posted in: a text channel, or the announcement
 * channel one becomes when a Community server converts it — its `#rules` channel, often.
 * Not just `isTextBased()`, which a thread and a voice channel's chat answer too.
 */
export type MessageChannel = TextChannel | NewsChannel;

/** Whether a channel is one a journey's message can live in ({@link MessageChannel}). */
export function isMessageChannel(channel: GuildBasedChannel): channel is MessageChannel {
    return channel.type === ChannelType.GuildText || channel.type === ChannelType.GuildAnnouncement;
}

/**
 * Resolve the channel a posted message lives in: cache first, then one fetch — a miss is not
 * proof of absence. `gone` only on Discord's own 10003. A channel that is there but holds no
 * messages a journey posts throws, as `lookupBoundChannel` throws on a wrong kind: ids are
 * never reused, so the record pointed at the wrong thing from the start.
 *
 * Every step that reaches a posted message goes through here — its presence, its repair and
 * its delete — so a text channel converted to an announcement channel stays readable to all
 * three, rather than unreadable forever (install blocked, uninstall refused).
 */
export async function lookupMessageChannel(
    guild: Guild,
    channelId: string
): Promise<{ readonly status: 'found'; readonly channel: MessageChannel } | { readonly status: 'gone' }> {
    let channel: GuildBasedChannel | null | undefined = guild.channels.cache.get(channelId);
    if (!channel) {
        try {
            channel = await guild.channels.fetch(channelId);
        } catch (error) {
            if (discordErrorCode(error) === DISCORD_UNKNOWN_CHANNEL) return { status: 'gone' };
            throw error;
        }
    }
    if (!channel) {
        throw new Error(`Discord returned nothing for channel ${channelId}, and did not say it was unknown.`);
    }
    if (!isMessageChannel(channel)) {
        throw new Error(`Channel ${channelId} exists but is not a text or announcement channel.`);
    }
    return { status: 'found', channel };
}

/**
 * Resolve a message the bot posted, by its channel and its id.
 *
 * `gone` only when Discord itself says so — the channel is unknown (10003), or the message
 * is (10008). A channel that denies the bot what reading a message needs is `unreadable`
 * before anything is asked: whether Discord would answer that read 10008 or 50001 is not
 * something to bet a repost on. Every other failure throws, for `lookupBoundChannel`'s
 * reason: install reposts on `gone`, and a network blip read as gone would post a second
 * copy.
 *
 * The channel comes from {@link lookupMessageChannel}. The message is always fetched, `force`
 * past the cache: a copy cached before a gap in the gateway connection proves nothing about now.
 *
 * The same fetch says whether somebody hid its embeds ({@link MessageLookup.embedsSuppressed}).
 */
export async function lookupBoundMessage(guild: Guild, channelId: string, messageId: string): Promise<MessageLookup> {
    const channel = await lookupMessageChannel(guild, channelId);
    if (channel.status === 'gone') return { presence: 'gone', embedsSuppressed: false };

    const me = guild.members.me;
    if (!me) {
        // Without the bot's own member there is nothing to check its permissions against —
        // which is not the same as lacking them.
        return {
            presence: { unreadable: "couldn't see the bot's own member, so its permissions there can't be checked" },
            embedsSuppressed: false,
        };
    }
    const granted = channel.channel.permissionsFor(me);
    const missing = READ_MESSAGE_PERMISSIONS.filter((permission) => !granted?.has(permission.flag));
    if (missing.length > 0) {
        return {
            presence: { unreadable: `the bot lacks ${missing.map((permission) => `**${permission.name}**`).join(' and ')} there` },
            embedsSuppressed: false,
        };
    }

    try {
        const message = await channel.channel.messages.fetch({ message: messageId, force: true });
        return {
            presence: 'found',
            embedsSuppressed: message.flags.has(MessageFlags.SuppressEmbeds),
            buttons: postedButtonsOf(message),
        };
    } catch (error) {
        const code = discordErrorCode(error);
        if (code === DISCORD_UNKNOWN_MESSAGE || code === DISCORD_UNKNOWN_CHANNEL) {
            return { presence: 'gone', embedsSuppressed: false };
        }
        throw error;
    }
}

/** A button a posted message carries that a journey's message resource put there (`mbtn:<key>`). */
export interface PostedButton {
    readonly key: string;
    /** What it is called, as it is posted: its label, else its emoji, else its key (`buttonDisplayName`). */
    readonly label: string;
}

/** The `mbtn:` buttons a fetched message carries, in row order. Any other component is not ours to name. */
function postedButtonsOf(message: Message): readonly PostedButton[] {
    return message.components.flatMap((row) =>
        row.type === ComponentType.ActionRow
            ? row.components.flatMap((component) => {
                  if (component.type !== ComponentType.Button || !component.customId) return [];
                  const key = parseMessageButtonCustomId(component.customId);
                  if (!key) return [];
                  const emoji = component.emoji?.name
                      ? { name: component.emoji.name, ...(component.emoji.id ? { id: component.emoji.id } : {}) }
                      : undefined;
                  return [{ key, label: buttonDisplayName({ key, label: component.label ?? undefined, emoji }) }];
              })
            : []
    );
}

/** One posted message as {@link lookupBoundMessage} read it. */
export interface MessageLookup {
    readonly presence: MessagePresence;
    /**
     * Whether its embeds are hidden — SUPPRESS_EMBEDS, which anyone with Manage Messages sets
     * through "Remove all embeds". The one change to the bot's own message somebody else can
     * make. Only ever true for a `found` message.
     */
    readonly embedsSuppressed: boolean;
    /** The `mbtn:` buttons it carries now. Present only for a `found` message. */
    readonly buttons?: readonly PostedButton[];
}

/** {@link readMessageState}'s answer: each posted message's presence, and which of them have their embeds hidden. */
export interface MessageState {
    readonly presence: ReadonlyMap<string, MessagePresence>;
    /** The resource keys of found messages whose embeds somebody suppressed. */
    readonly embedsSuppressed: ReadonlySet<string>;
    /** The `mbtn:` buttons each found message carries now, by resource key — what a repair could take away. */
    readonly postedButtons: ReadonlyMap<string, readonly PostedButton[]>;
}

/**
 * Whether each of these rows' messages is still posted, keyed by resource key: one read per
 * posted message row ({@link isPostedMessageRow}), one at a time. Every other row is skipped.
 *
 * Read once by each service call that plans (`previewInstall`, `previewUnpublish`,
 * `previewOrphans`) and handed to its planner, which stays synchronous. A lookup that
 * throws becomes `unreadable`, and so does a row recording no channel — written by
 * something other than `upsertPostedMessage` — so one bad row or one channel the bot
 * cannot see blocks that one item rather than the whole preview.
 */
export async function readMessagePresence(
    guild: Guild,
    rows: readonly ResourceBindingEntity[]
): Promise<ReadonlyMap<string, MessagePresence>> {
    return (await readMessageState(guild, rows)).presence;
}

/**
 * {@link readMessagePresence}, plus which found messages have their embeds hidden — from the
 * same one read per message. Drift's: a hidden embed is the one way a posted message stops
 * saying what its journey declares without its declaration moving.
 */
export async function readMessageState(guild: Guild, rows: readonly ResourceBindingEntity[]): Promise<MessageState> {
    const presence = new Map<string, MessagePresence>();
    const embedsSuppressed = new Set<string>();
    const postedButtons = new Map<string, readonly PostedButton[]>();

    for (const row of rows) {
        if (!isPostedMessageRow(row)) continue;
        if (!row.messageChannelId) {
            presence.set(row.resourceKey, { unreadable: 'its record names no channel to look in' });
            continue;
        }

        try {
            const lookup = await lookupBoundMessage(guild, row.messageChannelId, row.discordId);
            presence.set(row.resourceKey, lookup.presence);
            if (lookup.embedsSuppressed) embedsSuppressed.add(row.resourceKey);
            if (lookup.buttons) postedButtons.set(row.resourceKey, lookup.buttons);
        } catch (error) {
            presence.set(row.resourceKey, { unreadable: describeDiscordError(error) });
        }
    }

    return { presence, embedsSuppressed, postedButtons };
}
