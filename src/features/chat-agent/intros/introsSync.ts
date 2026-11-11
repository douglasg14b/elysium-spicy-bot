import { ChannelType, Events, MessageType, type Client, type Guild, type Message, type PartialMessage } from 'discord.js';
import { ALLOWED_GUILD_IDS } from '../../../environment';
import { isGuildAllowed } from '../../../features-system/guild-allowlist';
import { chatAgentConfigRepo } from '../data/chatAgentConfigRepo';
import { chatIntrosRepo, type ChatIntrosRepo } from '../data/chatIntrosRepo';
import type { IntroPost } from '../data/chatIntrosSchema';
import { botCanRead } from '../tools/visibleChannels';

/** How far back a rescan pages: 100 messages a page, so the newest 10,000 posts. */
const RESCAN_PAGE_LIMIT = 100;
const PAGE_SIZE = 100;

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
 * channel read newest first, {@link RESCAN_PAGE_LIMIT} pages at most, each intro written as
 * it is read. Only a read that reached the channel's first message drops posts the channel no
 * longer has (deleted while the bot was away); a capped one leaves the older ones be. Stops
 * early once `stillSaved` says the channel is no longer the saved one, since the next rescan owns it then.
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

    const seen = new Set<string>();
    let before: string | undefined;
    for (let page = 0; page < RESCAN_PAGE_LIMIT; page++) {
        if (!stillSaved()) return;
        const messages = await channel.messages.fetch({ limit: PAGE_SIZE, before });
        const intros = [...messages.values()].filter(isIntroPost).map(toIntroPost);
        await repo.savePosts(intros);
        for (const intro of intros) seen.add(intro.messageId);
        if (messages.size < PAGE_SIZE) {
            const gone = (await repo.listMessageIds(guild.id, channelId)).filter((messageId) => !seen.has(messageId));
            await repo.deletePosts(guild.id, gone);
            return;
        }
        before = messages.last()?.id;
    }
    console.warn(`[chat-agent] intros channel ${channelId} of guild ${guild.id} has over ${RESCAN_PAGE_LIMIT * PAGE_SIZE} messages; only the newest were copied`);
}

/** Whether `message` landed in its server's intros channel. */
function inIntrosChannel(message: Message | PartialMessage): boolean {
    return !!message.guildId && introsChannels.get(message.guildId) === message.channelId;
}

/** Record a new post or an edited one; an edit that makes it no intro (its text gone) drops it. */
async function recordPost(message: Message | PartialMessage): Promise<void> {
    const whole = message.partial ? await message.fetch() : message;
    if (!whole.inGuild()) return;
    if (isIntroPost(whole)) await chatIntrosRepo.savePosts([toIntroPost(whole)]);
    else await chatIntrosRepo.deletePosts(whole.guildId, [whole.id]);
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
        if (message.guildId && inIntrosChannel(message)) chatIntrosRepo.deletePosts(message.guildId, [message.id]).catch(report('forget'));
    });
    client.on(Events.MessageBulkDelete, (messages, channel) => {
        if (introsChannels.get(channel.guildId) === channel.id) chatIntrosRepo.deletePosts(channel.guildId, [...messages.keys()]).catch(report('forget'));
    });

    client.once(Events.ClientReady, (readyClient) => {
        loadIntrosChannels(readyClient).catch((error: unknown) => console.error('[chat-agent] could not load the intros channels:', error));
    });
}

/** Each allowed server's saved intros channel into the map, and a rescan queued for each. */
async function loadIntrosChannels(client: Client<true>): Promise<void> {
    for (const guild of client.guilds.cache.values()) {
        if (!isGuildAllowed(guild.id, ALLOWED_GUILD_IDS)) continue;
        const { introsChannelId } = await chatAgentConfigRepo.getConfig(guild.id);
        if (!introsChannelId) continue;
        introsChannels.set(guild.id, introsChannelId);
        queueRescan(guild, introsChannelId);
    }
}
