import { tool } from 'ai';
import { z } from 'zod';
import type { GuildTextBasedChannel } from 'discord.js';
import { describeContent } from '../session/discordHistory';
import type { ChatToolContext } from './chatToolContext';
import { matchChannel, readableTextChannel, type Viewers } from './visibleChannels';

const CHANNEL_TEXT_MESSAGE_LIMIT = 20;
const CHANNEL_TEXT_CHARACTER_LIMIT = 8_000;
const CHANNEL_TEXT_CACHE_TTL_MS = 10 * 60_000;
const ROLE_LIST_LIMIT = 40;
const DESCRIPTION_LIMIT = 500;

type CachedText = { text: string; readAt: number };

/**
 * Rules and context channels change rarely and are asked about often; one read serves ten
 * minutes. Process-wide.
 */
const channelTextCache = new Map<string, CachedText>();

/**
 * The text of a channel's latest messages, oldest first, capped — how a rules or context
 * channel is read. Cached per channel *and* readership (asker and answer channel), because the
 * channel mentions inside are resolved for whoever will read it.
 */
async function readChannelText(
    channel: GuildTextBasedChannel,
    viewers: Viewers,
    answerChannelId: string,
    now: number = Date.now()
): Promise<string> {
    const cacheKey = `${channel.id}:${viewers[0].id}:${answerChannelId}`;
    const cached = channelTextCache.get(cacheKey);
    if (cached && now - cached.readAt < CHANNEL_TEXT_CACHE_TTL_MS) return cached.text;

    const messages = await channel.messages.fetch({ limit: CHANNEL_TEXT_MESSAGE_LIMIT });
    const text = [...messages.values()]
        .reverse()
        .map((message) => describeContent(message, viewers))
        .filter((content) => content.length > 0)
        .join('\n\n')
        .slice(0, CHANNEL_TEXT_CHARACTER_LIMIT);
    for (const [key, entry] of channelTextCache) {
        if (now - entry.readAt >= CHANNEL_TEXT_CACHE_TTL_MS) channelTextCache.delete(key);
    }
    channelTextCache.set(cacheKey, { text, readAt: now });
    return text;
}

/**
 * The server's configured context channels marked (`isRules`) or not, that everyone who will
 * read the answer can read, in saved order. One gone from the server, or hidden from any of them, is left out.
 */
function readableContextChannels(context: ChatToolContext, isRules: boolean): GuildTextBasedChannel[] {
    return context.contextChannels
        .filter((entry) => entry.isRules === isRules)
        .map((entry) => readableTextChannel(context.viewers, context.guild.channels.cache.get(entry.channelId)))
        .filter((channel): channel is GuildTextBasedChannel => !!channel);
}

/**
 * The channels rules are read from: the context channels marked as rules when the server has
 * any — then only those, even when the readers can read none of them — else Discord's rules channel.
 */
function rulesChannels(context: ChatToolContext): GuildTextBasedChannel[] {
    if (context.contextChannels.some((entry) => entry.isRules)) return readableContextChannels(context, true);
    const discordRules = readableTextChannel(context.viewers, context.guild.rulesChannel);
    return discordRules ? [discordRules] : [];
}

export function getServerRulesTool(context: ChatToolContext) {
    return tool({
        description:
            "Read the server's rules from its rules channel(s). Use before answering anything about what is or isn't allowed, and quote or paraphrase them rather than guessing.",
        inputSchema: z.object({}),
        execute: async () => {
            const channels = rulesChannels(context);
            if (channels.length === 0) {
                return { found: false as const, note: 'This server has no rules channel everyone here can see.' };
            }
            const sources = await Promise.all(
                channels.map(async (channel) => ({
                    channel: `#${channel.name}`,
                    rules: await readChannelText(channel, context.viewers, context.channel.id),
                }))
            );
            return { found: true as const, sources };
        },
    });
}

/**
 * One of the server's context channels that are not rules channels, by name or id. Only
 * those everyone who will read the answer can read are offered, named in the description, or
 * found — so its description, built for this turn, names nothing any of them cannot see.
 */
export function readContextChannelTool(context: ChatToolContext) {
    const names = readableContextChannels(context, false).map((channel) => `#${channel.name}`);
    return tool({
        description:
            "Read the recent messages of one of the server's context channels — channels its admins picked for you to know about. " +
            (names.length > 0
                ? `Available: ${names.join(', ')}. Use when a question touches what one of them covers.`
                : 'There are none everyone here can read.'),
        inputSchema: z.object({
            channel: z.string().describe('Context channel name, with or without #.'),
        }),
        execute: async ({ channel: query }) => {
            const readable = readableContextChannels(context, false);
            const channel = matchChannel(readable, query);
            if (!channel) {
                return {
                    found: false as const,
                    note: 'No context channel everyone here can read goes by that.',
                    available: readable.map((candidate) => `#${candidate.name}`),
                };
            }
            return { found: true as const, channel: `#${channel.name}`, text: await readChannelText(channel, context.viewers, context.channel.id) };
        },
    });
}

export function getServerInfoTool(context: ChatToolContext) {
    return tool({
        description: "Facts about this server: name, description, member count, age, boosts, and its roles' names.",
        inputSchema: z.object({}),
        execute: async () => {
            const { guild } = context;
            const roles = [...guild.roles.cache.values()]
                .filter((role) => role.id !== guild.id && !role.managed)
                .sort((left, right) => right.position - left.position)
                .slice(0, ROLE_LIST_LIMIT)
                .map((role) => role.name);
            return {
                name: guild.name,
                description: guild.description?.slice(0, DESCRIPTION_LIMIT) ?? null,
                memberCount: guild.memberCount,
                createdAt: guild.createdAt.toISOString(),
                boostTier: guild.premiumTier,
                boostCount: guild.premiumSubscriptionCount ?? 0,
                rulesChannels: rulesChannels(context).map((channel) => `#${channel.name}`),
                roles,
            };
        },
    });
}
