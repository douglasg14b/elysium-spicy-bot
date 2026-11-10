import { APICallError } from 'ai';
import type { LanguageModel } from 'ai';
import { DiscordAPIError, PermissionFlagsBits, RESTJSONErrorCodes } from 'discord.js';
import type { ClientUser, Message, MessageMentionOptions } from 'discord.js';
import { guildSettingsRepo } from '../../features-system/guild-settings';
import type { PerGuildQueue } from '../../shared/perGuildQueue';
import { turnLimitsFor } from './agent/runChatTurn';
import { runReviewedTurn, type ReviewedTurn } from './agent/runReviewedTurn';
import type { ChatRateLimiter } from './safety/rateLimit';
import { NEW_SESSION, sessionTurnFrom, type ChatSessions } from './session/chatSessions';
import { readChannelHistory } from './session/discordHistory';
import { historyToModelMessages } from './session/historyToModelMessages';
import { sessionMemory } from './session/sessionReplay';
import { buildChatTools } from './tools/buildChatTools';
import { buildChatToolContext, findLiveTicket } from './tools/chatToolContext';
import type { TicketEntity } from '../tickets';
import { mightBeForBot, readTriggerFacts, resolveTrigger, type RepliedTo } from './trigger/triggerGate';

/** The long-lived pieces one handler call works with; one set per process. */
export type ChatAgentDependencies = {
    readonly sessions: Pick<ChatSessions, 'resolve' | 'record'>;
    /** One turn at a time per channel — keyed by channel id, not guild. */
    readonly channelQueue: PerGuildQueue;
    /** Turns queued or running per channel, for {@link MAX_QUEUED_TURNS_PER_CHANNEL}. */
    readonly pendingTurns: Map<string, number>;
    readonly rateLimiter: ChatRateLimiter;
    readonly model: LanguageModel;
};

/**
 * More than this many turns waiting in one channel and new ones are dropped: answers
 * minutes late to a conversation that has moved on are worse than none, and each costs a
 * model call. The per-member rate limit cannot bound this; many members can each queue.
 */
const MAX_QUEUED_TURNS_PER_CHANNEL = 3;

/** Discord shows "typing…" for about ten seconds; renewed a little sooner. */
const TYPING_RENEW_MS = 8_000;

const RATE_LIMIT_WARNING = "Slow down. I'm one bot and you're not my only fan — I'll pick this back up with you in a few minutes.";
const EMPTY_ANSWER_REPLY = "I had a thought and lost it somewhere. Ask me again.";
const FAILED_TURN_REPLY = "Ugh, my circuits are being extra bratty right now. Try again in a sec.";

/** The model never pings anyone. */
const NO_PINGS: MessageMentionOptions = { parse: [] };
/** A reply pings only the person it replies to, and still posts if their message was deleted meanwhile. */
const REPLY_OPTIONS = { allowedMentions: { ...NO_PINGS, repliedUser: true }, failIfNotExists: false } as const;

/**
 * Answers a message addressed to the bot: decides it is one, holds a member to the rate
 * limit, then queues the turn behind any other in the same channel.
 */
export async function handleChatMessage(message: Message, botUser: ClientUser, deps: ChatAgentDependencies): Promise<void> {
    if (!mightBeForBot(message, botUser.id) || !message.inGuild()) return;

    const me = message.guild.members.me;
    if (!me || !message.channel.permissionsFor(me)?.has(PermissionFlagsBits.SendMessages)) return;

    // A thread in a ticket channel is part of the ticket.
    const ticketChannelId = message.channel.isThread() ? (message.channel.parentId ?? message.channelId) : message.channelId;
    const ticket = await findLiveTicket(ticketChannelId);
    // Only a reply to the bot, outside a ticket, needs the reply chain: inside one, only a mention counts.
    const repliesToBot = !!message.reference?.messageId && message.mentions.repliedUser?.id === botUser.id;
    const repliedTo = !ticket && repliesToBot ? await fetchRepliedChain(message) : null;
    // A reply to the bot names the post whose session it may carry on, ticket or not.
    const repliedToId = repliesToBot ? (message.reference?.messageId ?? null) : null;
    const trigger = resolveTrigger(readTriggerFacts(message, botUser.id, repliedTo, !!ticket));
    if (trigger.kind === 'none') return;

    const decision = deps.rateLimiter.attempt(message.guildId, message.author.id);
    switch (decision) {
        case 'ignore':
            return;
        case 'warn':
            await message.reply({ content: RATE_LIMIT_WARNING, ...REPLY_OPTIONS });
            return;
        case 'allow':
            await queueTurn({ message, ticket, repliedToId }, botUser, deps);
            return;
    }
}

/** The message `message` replies to, and the message that one answered; null where Discord no longer has it. */
async function fetchRepliedChain(message: Message<true>): Promise<RepliedTo | null> {
    const repliedTo = await fetchReferenceOrNull(message);
    if (!repliedTo) return null;
    const answered = repliedTo.reference?.messageId ? await fetchReferenceOrNull(repliedTo) : null;
    return { message: repliedTo, answered };
}

async function fetchReferenceOrNull(message: Message): Promise<Message | null> {
    try {
        return await message.fetchReference();
    } catch (error) {
        if (error instanceof DiscordAPIError && error.code === RESTJSONErrorCodes.UnknownMessage) return null;
        throw error;
    }
}

/** One message the bot will answer, and what the gate found out about it on the way. */
type ChatRequest = {
    readonly message: Message<true>;
    /** The live ticket the channel is, or null. */
    readonly ticket: TicketEntity | null;
    /** The bot's message it replies to, whose session it may carry on; null when it replies to none. */
    readonly repliedToId: string | null;
};

async function queueTurn(request: ChatRequest, botUser: ClientUser, deps: ChatAgentDependencies): Promise<void> {
    const { message } = request;
    const pending = deps.pendingTurns.get(message.channelId) ?? 0;
    if (pending >= MAX_QUEUED_TURNS_PER_CHANNEL) {
        console.warn(`[chat-agent] channel ${message.channelId} has ${pending} turns waiting; dropped one`);
        return;
    }
    deps.pendingTurns.set(message.channelId, pending + 1);
    try {
        await deps.channelQueue(message.channelId, () => answer(request, botUser, deps));
    } finally {
        const left = (deps.pendingTurns.get(message.channelId) ?? 1) - 1;
        if (left > 0) deps.pendingTurns.set(message.channelId, left);
        else deps.pendingTurns.delete(message.channelId);
    }
}

async function answer({ message, ticket, repliedToId }: ChatRequest, botUser: ClientUser, deps: ChatAgentDependencies): Promise<void> {
    const stopTyping = keepTyping(message);
    let postedIds: string[] = [];
    try {
        const asker = message.member ?? (await message.guild.members.fetch(message.author.id));
        const [context, timeZone] = await Promise.all([
            buildChatToolContext(message.channel, asker, ticket),
            guildSettingsRepo.getTimeZone(message.guildId),
        ]);
        const history = await readChannelHistory(message.channel, message, botUser.id, {
            viewers: context.viewers,
            canReadHistory: context.viewersCanReadHistory,
        });
        const modelId = typeof deps.model === 'string' ? deps.model : deps.model.modelId;
        // The session is an aid: one that cannot be read costs this turn its memory, never its answer.
        const session = await deps.sessions.resolve(message, botUser.id, repliedToId).catch((error: unknown) => {
            console.error(`[chat-agent] could not read the session in channel ${message.channelId}: ${describeFailure(error)}`);
            return NEW_SESSION;
        });
        const messages = historyToModelMessages(history, sessionMemory(session.turns, history, { ...context, modelId }));

        const tools = buildChatTools(context);
        const limits = turnLimitsFor(context);
        const botName = message.guild.members.me?.displayName ?? botUser.displayName;
        const reviewed = await runReviewedTurn(
            {
                context,
                tools,
                messages,
                timeZone: timeZone.effective,
                model: deps.model,
                botName,
                maxSteps: limits.maxSteps,
                // A turn that has not answered by then is abandoned with the fallback line.
                abortSignal: AbortSignal.timeout(limits.timeoutMs),
            },
            { viewers: context.viewers, inTicket: !!ticket, botName, toolNames: Object.keys(tools) }
        );
        logTurn(message, reviewed);

        if (reviewed.outcome === 'quiet') return;
        if (reviewed.outcome === 'fallback') {
            // In a ticket, saying nothing is the default; no filler line.
            if (ticket) return;
            await message.reply({ content: EMPTY_ANSWER_REPLY, ...REPLY_OPTIONS });
            return;
        }
        const { turn, parts } = reviewed;

        try {
            await postReply(message, parts, (id) => postedIds.push(id));
        } finally {
            // Whatever did post is the bot's message now, with this turn behind it.
            if (postedIds.length > 0) {
                const posted = { parts, ids: postedIds };
                await Promise.resolve()
                    .then(() =>
                        deps.sessions.record({
                            sessionId: session.id,
                            guildId: message.guildId,
                            channelId: message.channelId,
                            turn: sessionTurnFrom({ history, context, modelId, messages: turn.responseMessages, posted }),
                            now: new Date(),
                        })
                    )
                    // The reply is posted; a session that missed it only costs the next turn its lookups.
                    .catch((error: unknown) => console.error(`[chat-agent] could not record the turn in channel ${message.channelId}: ${describeFailure(error)}`));
            }
        }
    } catch (error) {
        console.error(`[chat-agent] turn failed in channel ${message.channelId}: ${describeFailure(error)}`);
        // Half an answer already posted says more than an apology under it; in a ticket, so does silence.
        if (postedIds.length === 0 && !ticket) {
            await message
                .reply({ content: FAILED_TURN_REPLY, ...REPLY_OPTIONS })
                .catch((replyError: unknown) =>
                    console.error(`[chat-agent] could not post the failure reply: ${describeFailure(replyError)}`)
                );
        }
    } finally {
        stopTyping();
    }
}

/**
 * Posts the parts in order, reporting each id as it lands. **Every part is a reply** to
 * `message`: that is how a later reply to any of them is told apart from a reply to the
 * bot's other posts (`isChatAgentPost`). Only the first pings the asker.
 */
/** One line per turn: where, how many steps and tools, and what the output controls did. */
function logTurn(message: Message<true>, reviewed: ReviewedTurn): void {
    const turns = reviewed.redone ? [reviewed.redone.first, reviewed.turn] : [reviewed.turn];
    const steps = turns.reduce((total, turn) => total + turn.steps, 0);
    const tools = turns.flatMap((turn) => turn.toolCalls);
    const redo = reviewed.redone ? ` redo=[${reviewed.redone.problems.map((problem) => problem.kind).join(',')}]` : '';
    console.log(
        `[chat-agent] guild=${message.guildId} channel=${message.channelId} outcome=${reviewed.outcome} steps=${steps} tools=[${tools.join(',')}]${redo}`
    );
}

async function postReply(message: Message<true>, parts: readonly string[], onPosted: (id: string) => void): Promise<void> {
    const [first, ...rest] = parts;
    onPosted((await message.reply({ content: first, ...REPLY_OPTIONS })).id);
    for (const part of rest) {
        onPosted((await message.reply({ content: part, allowedMentions: { ...NO_PINGS, repliedUser: false }, failIfNotExists: false })).id);
    }
}

/**
 * A failure as one log line: name, message, the provider's status if it was one, and the
 * stack. Never the error object itself — the AI SDK's call errors carry the whole request
 * body, which is other members' messages.
 */
function describeFailure(error: unknown): string {
    if (APICallError.isInstance(error)) {
        return `${error.name} (status ${error.statusCode ?? 'none'}, retryable ${error.isRetryable}): ${error.message}`;
    }
    if (error instanceof Error) return error.stack ?? `${error.name}: ${error.message}`;
    return String(error);
}

/** Shows "typing…" until the returned function is called. A failed typing call is only logged. */
function keepTyping(message: Message<true>): () => void {
    const sendTyping = () =>
        message.channel
            .sendTyping()
            .catch((error: unknown) => console.warn(`[chat-agent] sendTyping failed: ${describeFailure(error)}`));
    void sendTyping();
    const timer = setInterval(() => void sendTyping(), TYPING_RENEW_MS);
    return () => clearInterval(timer);
}
