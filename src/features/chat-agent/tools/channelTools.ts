import { tool } from 'ai';
import { z } from 'zod';
import { ChannelType } from 'discord.js';
import type { GuildBasedChannel } from 'discord.js';
import { describeContent } from '../session/discordHistory';
import type { ChatToolContext } from './chatToolContext';
import { findVisibleChannel, listVisibleChannels } from './visibleChannels';

const CHANNEL_LIST_LIMIT = 120;
const SEARCH_SCAN_LIMIT = 100;
const SEARCH_RESULT_LIMIT = 25;
const SEARCH_EXCERPT_LIMIT = 300;
/** Topics in a list are cut; `getChannelInfo` has the whole one. */
const LISTED_TOPIC_LIMIT = 150;

type ChannelKind = 'text' | 'voice' | 'stage' | 'announcement' | 'forum' | 'media' | 'thread' | 'category';

function channelKind(channel: GuildBasedChannel): ChannelKind {
    switch (channel.type) {
        case ChannelType.GuildText:
            return 'text';
        case ChannelType.GuildVoice:
            return 'voice';
        case ChannelType.GuildStageVoice:
            return 'stage';
        case ChannelType.GuildAnnouncement:
            return 'announcement';
        case ChannelType.GuildForum:
            return 'forum';
        case ChannelType.GuildMedia:
            return 'media';
        case ChannelType.PublicThread:
        case ChannelType.PrivateThread:
        case ChannelType.AnnouncementThread:
            return 'thread';
        case ChannelType.GuildCategory:
            return 'category';
    }
}

function topicOf(channel: GuildBasedChannel): string | null {
    return 'topic' in channel ? channel.topic : null;
}

export function listChannelsTool(context: ChatToolContext) {
    return tool({
        description:
            'List the channels everyone in this conversation can see, with their category and topic. Use to point people at the right place — write a channel as its #name. Threads are left out.',
        inputSchema: z.object({
            category: z.string().optional().describe('Only channels in a category whose name contains this.'),
        }),
        execute: async ({ category }) => {
            const wanted = category?.toLowerCase();
            const channels = listVisibleChannels(context.viewers)
                .filter((channel) => !channel.isThread())
                .filter((channel) => !wanted || (channel.parent?.name.toLowerCase().includes(wanted) ?? false))
                .slice(0, CHANNEL_LIST_LIMIT)
                .map((channel) => ({
                    name: `#${channel.name}`,
                    kind: channelKind(channel),
                    category: channel.parent?.name ?? null,
                    topic: topicOf(channel)?.slice(0, LISTED_TOPIC_LIMIT) ?? null,
                }));
            return { channels };
        },
    });
}

export function getChannelInfoTool(context: ChatToolContext) {
    return tool({
        description: "Details of one channel everyone in this conversation can see: topic, category, whether it's NSFW, slowmode.",
        inputSchema: z.object({
            channel: z.string().describe('Channel name, with or without #.'),
        }),
        execute: async ({ channel: query }) => {
            const channel = findVisibleChannel(context.viewers, query);
            if (!channel) return { found: false as const, note: `No channel matching "${query}" that everyone here can see.` };
            return {
                found: true as const,
                name: `#${channel.name}`,
                kind: channelKind(channel),
                category: channel.parent?.name ?? null,
                topic: topicOf(channel),
                nsfw: 'nsfw' in channel ? channel.nsfw : false,
                slowmodeSeconds: 'rateLimitPerUser' in channel ? (channel.rateLimitPerUser ?? 0) : 0,
            };
        },
    });
}

export function searchRecentMessagesTool(context: ChatToolContext) {
    return tool({
        description: `Search the last ${SEARCH_SCAN_LIMIT} messages of this channel for text or an author's name. Use when someone refers to something said earlier that isn't in view.`,
        inputSchema: z.object({
            query: z.string().min(1).describe('Words to look for, matched case-insensitively against text and author.'),
            limit: z.number().int().min(1).max(SEARCH_RESULT_LIMIT).optional(),
        }),
        execute: async ({ query, limit }) => {
            if (!context.viewersCanReadHistory) {
                return { matches: [], note: "Not everyone here can read this channel's history, so you can't search it for them." };
            }
            const needle = query.toLowerCase();
            const messages = await context.channel.messages.fetch({ limit: SEARCH_SCAN_LIMIT });
            const matches = [...messages.values()]
                .map((message) => ({
                    author: message.member?.displayName ?? message.author.displayName,
                    at: message.createdAt.toISOString(),
                    text: describeContent(message, context.viewers),
                }))
                .filter((message) => `${message.author}\n${message.text}`.toLowerCase().includes(needle))
                .slice(0, limit ?? 10)
                .map((message) => ({ ...message, text: message.text.slice(0, SEARCH_EXCERPT_LIMIT) }));
            return { matches };
        },
    });
}
