import { tool } from 'ai';
import type { Guild } from 'discord.js';
import { chatIntrosRepo, type ChatIntrosRepo } from '../data/chatIntrosRepo';
import { cutText } from '../session/discordHistory';
import type { ChatToolContext } from './chatToolContext';
import { memberInput, resolveMember } from './memberTools';
import { everyoneCanSee, readableTextChannel, type Viewers } from './visibleChannels';

/** How many of someone's intro posts are read: an intro is often split across a few messages, or redone later. */
const INTRO_POST_LIMIT = 3;
const INTRO_POST_CHARACTER_LIMIT = 1_500;

/**
 * Stored text as its readers would see it: members and roles by name, a channel only when
 * every viewer can see it, custom emoji as `:name:` — as `describeContent` does for a live
 * message, from the guild's caches since a stored post has no `mentions`.
 */
export function resolveStoredMentions(text: string, guild: Guild, viewers: Viewers): string {
    return text
        .replace(/<@!?(\d+)>/g, (_match, userId: string) => `@${guild.members.cache.get(userId)?.displayName ?? 'someone'}`)
        .replace(/<@&(\d+)>/g, (_match, roleId: string) => `@${guild.roles.cache.get(roleId)?.name ?? 'role'}`)
        .replace(/<#(\d+)>/g, (_match, channelId: string) => {
            const channel = guild.channels.cache.get(channelId);
            return channel && everyoneCanSee(viewers, channel) ? `#${channel.name}` : '#unknown-channel';
        })
        .replace(/<a?:(\w+):\d+>/g, (_match, emojiName: string) => `:${emojiName}:`)
        .trim();
}

/**
 * What a member wrote about themselves in the server's intros channel, from the copy
 * `intros/introsSync.ts` keeps. Answers only when everyone who will read the reply can read
 * that channel themselves, as every channel read here does — so its description names the
 * channel only then.
 */
export function getMemberIntroTool(context: ChatToolContext, repo: ChatIntrosRepo = chatIntrosRepo) {
    const { guild, viewers } = context;
    const introsChannel = readableTextChannel(viewers, context.introsChannelId ? guild.channels.cache.get(context.introsChannelId) : undefined);
    return tool({
        description:
            'What a member wrote about themselves when they introduced themselves to the server — who they are, what they are into, their pronouns if they gave them. ' +
            (introsChannel
                ? `Read from #${introsChannel.name}. Use it for context about a person; sum up, don't recite.`
                : 'There is no intros channel everyone here can read, so it finds nothing.'),
        inputSchema: memberInput,
        execute: async ({ member: query }) => {
            if (!introsChannel) return { found: false as const, note: 'This server has no intros channel everyone here can read.' };
            const member = await resolveMember(context, query);
            if (!member) return { found: false as const, note: `Nobody here matches "${query}".` };
            const posts = await repo.findByAuthor(guild.id, introsChannel.id, member.id, INTRO_POST_LIMIT);
            if (posts.length === 0) {
                return { found: true as const, displayName: member.displayName, hasIntro: false as const, note: `No intro from them in #${introsChannel.name}.` };
            }
            return {
                found: true as const,
                displayName: member.displayName,
                hasIntro: true as const,
                channel: `#${introsChannel.name}`,
                // Oldest first, as they were written.
                posts: posts.reverse().map((post) => ({
                    postedAt: post.postedAt.toISOString(),
                    text: cutText(resolveStoredMentions(post.content, guild, viewers), INTRO_POST_CHARACTER_LIMIT),
                })),
            };
        },
    });
}
