import { ChannelType, Events, MessageType, type Client, type Guild, type Message, type PartialMessage } from 'discord.js';
import { ALLOWED_GUILD_IDS } from '../../../environment';
import { isGuildAllowed } from '../../../features-system/guild-allowlist';
import { chatAgentConfigRepo } from '../data/chatAgentConfigRepo';
import { chatIntrosRepo, type ChatIntrosRepo } from '../data/chatIntrosRepo';
import type { IntroPost } from '../data/chatIntrosSchema';
import { botCanRead } from '../tools/visibleChannels';

/** How far back a rescan pages: 100 messages a page, so the newest 10,000 posts. */
const RESCAN_MAX_PAGES = 100;
const PAGE_SIZE = 100;

/**
 * For each server mid-rescan, the posts the live listeners have written or deleted since it
 * began. The live write is newer than any page the rescan holds, so the rescan neither
 * overwrites one (an edit put back to its old text, a delete undone) nor prunes one (a post
 * that landed after the page that would have held it).
 */
const touchedDuringRescan = new Map<string, Set<string>>();

/** Note that the live listeners wrote or deleted these posts of `guildId`, for a rescan running there. */
export function noteLiveWrite(guildId: string, messageIds: readonly string[]): void {
    const touched = touchedDuringRescan.get(guildId);
    if (touched) for (const messageId of messageIds) touched.add(messageId);
}

/**
 * Each server's intros channel, as saved, so a message anywhere is matched against it without
 * a database read. Filled at `ClientReady` and kept by {@link introsChannelSaved}, the save's
 * one way in.
 */
const introsChannels = new Map<string, string>();

/** One rescan at a time across the bot, in the order asked: a channel's history is many requests. */
let rescans: Promise<void> = Promise.resolve();

/**
 * Whether `message` is someone introducing themselves: a member's own post (not a bot's, not a
 * system line), with text, that is not a reply — the "welcome!"s under an intro are other
 * people's words about them, not theirs.
 */
export function isIntroPost(message: Message): boolean {
    return !message.author.bot && !message.system && message.type === MessageType.Default && message.content.trim().length > 0;
}

function toIntroPost(message: Message<true>): IntroPost {
    return {
        messageId: message.id,
        guildId: message.guildId,
        channelId: message.channelId,
        authorId: message.author.id,
        content: message.content,
        postedAt: message.createdAt,
    };
}

/**
 * The intros channel was saved as `channelId` (null: none). The copy drops what it held from
 * any other channel and reads the new one whole; until then, the tool finds what it has.
 */
export function introsChannelSaved(guild: Guild, channelId: string | null): void {
    if (channelId) introsChannels.set(guild.id, channelId);
    else introsChannels.delete(guild.id);
    queueRescan(guild, channelId);
}

function queueRescan(guild: Guild, channelId: string | null): void {
    rescans = rescans
        .then(() => rescanIntros(guild, channelId))
        .catch((error: unknown) => console.error(`[chat-agent] could not read the intros channel of guild ${guild.id}:`, error));
}

/**
 * Make `guild`'s copy match `channelId`: everything from another channel dropped, then the
 * channel read newest first, {@link RESCAN_MAX_PAGES} pages at most, each intro written as
 * it is read — except one the live listeners have touched meanwhile ({@link noteLiveWrite}),
 * whose live write is newer. Only a read that reached the channel's first message drops posts
 * the channel no longer has (deleted while the bot was away), never a touched one; a capped
 * read leaves the older ones be. Stops early once `stillSaved` says the channel is no longer
 * the saved one, since the next rescan owns it then.
 */
export async function rescanIntros(
    guild: Guild,
    channelId: string | null,
    repo: ChatIntrosRepo = chatIntrosRepo,
    stillSaved: () => boolean = () => introsChannels.get(guild.id) === channelId
): Promise<void> {
    await repo.deleteOutsideChannel(guild.id, channelId);
    if (!channelId) return;

    const channel = guild.channels.cache.get(channelId);
    if (!channel || channel.type !== ChannelType.GuildText || !botCanRead(guild, channel)) {
        console.warn(`[chat-agent] intros channel ${channelId} of guild ${guild.id} is not a text channel the bot can read; nothing copied`);
        return;
    }

    const touched = new Set<string>();
    touchedDuringRescan.set(guild.id, touched);
    try {
        const seen = new Set<string>();
        let before: string | undefined;
        for (let page = 0; page < RESCAN_MAX_PAGES; page++) {
            if (!stillSaved()) return;
            const messages = await channel.messages.fetch({ limit: PAGE_SIZE, before });
            const intros = [...messages.values()].filter(isIntroPost).map(toIntroPost);
            await repo.savePosts(intros.filter((intro) => !touched.has(intro.messageId)));
            for (const intro of intros) seen.add(intro.messageId);
            if (messages.size < PAGE_SIZE) {
                const held = await repo.listMessageIds(guild.id, channelId);
                await repo.deletePosts(guild.id, held.filter((messageId) => !seen.has(messageId) && !touched.has(messageId)));
                return;
            }
            before = messages.last()?.id;
        }
        console.warn(`[chat-agent] intros channel ${channelId} of guild ${guild.id} has over ${RESCAN_MAX_PAGES * PAGE_SIZE} messages; only the newest were copied`);
    } finally {
        touchedDuringRescan.delete(guild.id);
    }
}

/** Whether `message` landed in its server's intros channel. */
function inIntrosChannel(message: Message | PartialMessage): boolean {
    return !!message.guildId && introsChannels.get(message.guildId) === message.channelId;
}

/** Record a new post or an edited one; an edit that makes it no intro (its text gone) drops it. */
async function recordPost(message: Message | PartialMessage): Promise<void> {
    const whole = message.partial ? await message.fetch() : message;
    if (!whole.inGuild()) return;
    noteLiveWrite(whole.guildId, [whole.id]);
    if (isIntroPost(whole)) await chatIntrosRepo.savePosts([toIntroPost(whole)]);
    else await chatIntrosRepo.deletePosts(whole.guildId, [whole.id]);
}

/** Drop deleted posts from the copy. */
async function forgetPosts(guildId: string, messageIds: readonly string[]): Promise<void> {
    noteLiveWrite(guildId, messageIds);
    await chatIntrosRepo.deletePosts(guildId, messageIds);
}

/**
 * Keeps the copy of each allowed server's intros channel: every post as it lands, is edited or
 * is deleted, and the whole channel at `ClientReady` (posts made, changed or deleted while the
 * bot was away). Only the saved channel's messages are looked at.
 */
export function initIntrosSync(client: Client): void {
    const report = (what: string) => (error: unknown) => console.error(`[chat-agent] could not ${what} an intro:`, error);

    client.on(Events.MessageCreate, (message) => {
        if (inIntrosChannel(message)) recordPost(message).catch(report('record'));
    });
    client.on(Events.MessageUpdate, (_old, message) => {
        if (inIntrosChannel(message)) recordPost(message).catch(report('update'));
    });
    client.on(Events.MessageDelete, (message) => {
        if (message.guildId && inIntrosChannel(message)) forgetPosts(message.guildId, [message.id]).catch(report('forget'));
    });
    client.on(Events.MessageBulkDelete, (messages, channel) => {
        if (introsChannels.get(channel.guildId) === channel.id) forgetPosts(channel.guildId, [...messages.keys()]).catch(report('forget'));
    });

    client.once(Events.ClientReady, (readyClient) => {
        void loadIntrosChannels(readyClient);
    });
    // A server unavailable at ready had no channels to read then; read it once it is back.
    client.on(Events.GuildAvailable, (guild) => {
        const channelId = introsChannels.get(guild.id);
        if (channelId) queueRescan(guild, channelId);
    });
}

/** Each allowed server's saved intros channel into the map, and a rescan queued for each; one server's failure skips only it. */
async function loadIntrosChannels(client: Client<true>): Promise<void> {
    for (const guild of client.guilds.cache.values()) {
        if (!isGuildAllowed(guild.id, ALLOWED_GUILD_IDS)) continue;
        try {
            const { introsChannelId } = await chatAgentConfigRepo.getConfig(guild.id);
            // A save while the config was read has already set the map and queued its own rescan.
            if (!introsChannelId || introsChannels.has(guild.id)) continue;
            introsChannels.set(guild.id, introsChannelId);
            queueRescan(guild, introsChannelId);
        } catch (error) {
            console.error(`[chat-agent] could not load the intros channel of guild ${guild.id}:`, error);
        }
    }
}
