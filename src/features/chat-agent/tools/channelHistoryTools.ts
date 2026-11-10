import { tool } from 'ai';
import { z } from 'zod';
import { DiscordAPIError, DiscordjsError, DiscordjsErrorCodes, RESTJSONErrorCodes } from 'discord.js';
import type { Collection, Guild, GuildBasedChannel, GuildTextBasedChannel, Message } from 'discord.js';
import { authorNameOf, cutText, describeContent, repliedToNameOf } from '../session/discordHistory';
import { channelIdFromReference, parseMessageLink } from './channelReferences';
import type { ChatToolContext } from './chatToolContext';
import { staffOnlyRefusal } from './staffAccess';
import { matchChannel, readableTextChannel } from './visibleChannels';

/** Messages a page holds. */
export const HISTORY_PAGE_SIZE = 50;

/** Pages one turn may read, across every channel: about 500 messages. */
export const HISTORY_PAGE_BUDGET = 10;

/** Characters of pages one turn may read, whatever their count — a page of walls of text is ten of small talk. */
export const HISTORY_CHARACTER_BUDGET = 120_000;

/** A paged message's text is cut shorter than a history message's, so ten pages stay readable. */
const PAGED_MESSAGE_LIMIT = 600;

/** What Discord answers about a channel the bot may not read, or one that is not this server's: none, to the model. */
const NO_SUCH_CHANNEL_CODES: ReadonlySet<number | string> = new Set([
    RESTJSONErrorCodes.UnknownChannel,
    RESTJSONErrorCodes.MissingAccess,
    RESTJSONErrorCodes.MissingPermissions,
]);

function isNoSuchChannel(error: unknown): boolean {
    if (error instanceof DiscordAPIError) return NO_SUCH_CHANNEL_CODES.has(error.code);
    return error instanceof DiscordjsError && error.code === DiscordjsErrorCodes.GuildChannelUnowned;
}

/** The channel with `id` — a thread nobody has opened since the bot started included — or undefined when there is none the bot may read. */
async function channelById(guild: Guild, id: string): Promise<GuildBasedChannel | undefined> {
    const cached = guild.channels.cache.get(id);
    if (cached) return cached;
    try {
        return (await guild.channels.fetch(id)) ?? undefined;
    } catch (error) {
        if (isNoSuchChannel(error)) return undefined;
        throw error;
    }
}

/** The channel `query` names — a link or an id by id, a name among the readable channels the cache holds — if every reader can read it. */
async function findReadableChannel(context: ChatToolContext, query: string): Promise<GuildTextBasedChannel | undefined> {
    const id = channelIdFromReference(query) ?? (/^\d{15,22}$/.test(query.trim()) ? query.trim() : null);
    const candidate = id
        ? await channelById(context.guild, id)
        : matchChannel(
              [...context.guild.channels.cache.values()].filter((channel) => readableTextChannel(context.viewers, channel)),
              query
          );
    return readableTextChannel(context.viewers, candidate);
}

export type PagedMessage = {
    readonly author: string;
    /** `2026-11-08T21:50Z`: minutes are enough, and UTC, as every tool gives times. */
    readonly at: string;
    readonly text: string;
    readonly replyTo?: string;
    /** Written by a bot or a webhook: what it says is a post, not a person. */
    readonly bot?: true;
    /** The message the link pointed at. */
    readonly linked?: true;
};

function toPagedMessage(message: Message, context: ChatToolContext, linkedId: string | null): PagedMessage {
    const replyTo = repliedToNameOf(message);
    return {
        author: authorNameOf(message),
        at: `${message.createdAt.toISOString().slice(0, 16)}Z`,
        text: cutText(describeContent(message, context.viewers), PAGED_MESSAGE_LIMIT),
        ...(replyTo ? { replyTo } : {}),
        ...(message.author.bot || message.webhookId ? { bot: true as const } : {}),
        ...(message.id === linkedId ? { linked: true as const } : {}),
    };
}

/** A channel as the model writes it: a #name, or — a thread, which cannot be linked — its name and the #channel it is in. */
function describeWhere(channel: GuildTextBasedChannel): { readonly channel: string; readonly thread?: string } {
    if (channel.isThread() && channel.parent) return { channel: `#${channel.parent.name}`, thread: channel.name };
    return { channel: `#${channel.name}` };
}

/**
 * Where to carry on from: the oldest message read, unless the read reached the start of
 * the channel. A page *before* that comes back short has. A page *around* a link holds
 * about half its messages from after it, so it has only when fewer than half are older.
 */
function continueBeforeOf(oldestFirst: readonly Message[], linkedId: string | null): string | null {
    const oldest = oldestFirst[0];
    if (!oldest) return null;
    if (!linkedId) return oldestFirst.length === HISTORY_PAGE_SIZE ? oldest.id : null;
    const older = oldestFirst.filter((message) => BigInt(message.id) < BigInt(linkedId)).length;
    return older >= HISTORY_PAGE_SIZE / 2 ? oldest.id : null;
}

/**
 * Staff reading back through another channel — a ticket, a thread, or from a message link —
 * a page at a time, for as long as it takes. For staff only, where every reader is staff
 * (`staffOnlyRefusal`), and only channels every reader could scroll themselves
 * (`readableTextChannel`). One budget per turn — {@link HISTORY_PAGE_BUDGET} pages and
 * {@link HISTORY_CHARACTER_BUDGET} characters — kept by the tool, which is built per turn;
 * a page is spent when its read starts, so calls made together cannot overrun it.
 */
export function readChannelMessagesTool(context: ChatToolContext) {
    let pagesStarted = 0;
    let charactersRead = 0;
    return tool({
        description: `For staff: read the messages of a channel, ticket channel or thread on this server, ${HISTORY_PAGE_SIZE} at a time, oldest first. Give a channel (#name, mention or id) or a message link — a link starts at that message, with the ones around it. To read further back, call again with \`before\` set to the \`continueBefore\` you got, until you have enough to answer; \`continueBefore\` is null at the start of the channel. Up to ${HISTORY_PAGE_BUDGET} pages a turn. A thread comes back as its name and the #channel it is in: write it by name, without a #. It says who may hear the answer.`,
        inputSchema: z.object({
            channel: z.string().min(1).describe('#name, <#id>, an id, or a Discord message link.'),
            before: z
                .string()
                .regex(/^\d{15,22}$/)
                .optional()
                .describe('Read the messages older than this one: the continueBefore of the last page.'),
        }),
        execute: async ({ channel: query, before }) => {
            const refusal = staffOnlyRefusal(context);
            if (refusal) return { found: false as const, ...refusal };
            if (pagesStarted >= HISTORY_PAGE_BUDGET || charactersRead >= HISTORY_CHARACTER_BUDGET) {
                return {
                    found: false as const,
                    note: "That's as much as one question may read. Answer with what you have, and say how far back you got.",
                };
            }
            const link = parseMessageLink(query);
            if (link && link.guildId !== context.guild.id) return { found: false as const, note: 'That link is to another server.' };

            pagesStarted += 1;
            const channel = await findReadableChannel(context, query);
            if (!channel) return { found: false as const, note: `No channel matching "${query}" that everyone here can read.` };

            const linkedId = before ? null : (link?.messageId ?? null);
            let page: Collection<string, Message>;
            try {
                page = linkedId
                    ? await channel.messages.fetch({ around: linkedId, limit: HISTORY_PAGE_SIZE })
                    : await channel.messages.fetch({ limit: HISTORY_PAGE_SIZE, ...(before ? { before } : {}) });
            } catch (error) {
                if (isNoSuchChannel(error)) return { found: false as const, note: `No channel matching "${query}" that everyone here can read.` };
                throw error;
            }

            const oldestFirst = [...page.values()].sort((left, right) => left.createdTimestamp - right.createdTimestamp);
            const messages = oldestFirst.filter((message) => !message.system).map((message) => toPagedMessage(message, context, linkedId));
            charactersRead += JSON.stringify(messages).length;
            return {
                found: true as const,
                ...describeWhere(channel),
                messages,
                ...(linkedId && !page.has(linkedId) ? { note: 'The linked message is gone; these are the ones around where it was.' } : {}),
                continueBefore: continueBeforeOf(oldestFirst, linkedId),
                pagesLeft: HISTORY_PAGE_BUDGET - pagesStarted,
            };
        },
    });
}
