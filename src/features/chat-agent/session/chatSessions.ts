import type { Message } from 'discord.js';
import type { ChatToolContext } from '../tools/chatToolContext';
import { chatSessionsRepo, type ChatSession, type ChatSessionsRepo, type NewSessionTurn, type RecordTurnInput, type SessionTurn } from '../data/chatSessionsRepo';
import type { ModelMessage } from 'ai';
import { unlinkReferences } from '../output/linkReferences';
import { listVisibleChannels } from '../tools/visibleChannels';
import { formatQuestion, type HistoryMessage } from './historyToModelMessages';

/** A session nobody has carried on for this long has ended. */
export const SESSION_IDLE_MS = 60 * 60_000;

/** A session has ended once this many other messages have been posted in its channel since the bot's last reply in it. */
export const SESSION_ACTIVITY_LIMIT = 45;

/**
 * A reply to one of a session's messages carries it on for this long after its last activity,
 * however idle or busy the channel since — and a session is deleted once this has passed.
 */
export const SESSION_REVIVAL_MS = 24 * 60 * 60_000;

/** A session keeps its newest this many turns; history's budget would never reach further back. */
export const MAX_TURNS_PER_SESSION = 20;

/** Discord's most messages a read returns: more than enough to tell whether {@link SESSION_ACTIVITY_LIMIT} have gone by. */
const ACTIVITY_READ_LIMIT = 100;

/** The session a turn carries on, with its turns so far — or `id: null`, a turn that starts one. */
export type ResolvedSession = { readonly id: string | null; readonly turns: readonly SessionTurn[] };

/** A new session: nothing to carry on. */
export const NEW_SESSION: ResolvedSession = { id: null, turns: [] };

export type RecordSessionTurnInput = Omit<RecordTurnInput, 'keepTurns'>;

/** How often sessions past their day are swept, apart from every recorded turn sweeping too. */
export const SESSION_SWEEP_INTERVAL_MS = 60 * 60_000;

type SessionsRepo = Pick<ChatSessionsRepo, 'findByPost' | 'findLatestInChannel' | 'listTurns' | 'recordTurn' | 'deleteInactiveSince' | 'deleteTurnsTouching'>;

/**
 * The chat agent's conversations, one channel at a time, shared by everyone in it. Persisted
 * (`chatSessionsRepo`), so a restart loses nothing.
 *
 * A mention or a reply to the bot starts a session, and every one after it in the channel
 * carries it on until it ends: an hour with no turn, or {@link SESSION_ACTIVITY_LIMIT} other
 * messages since the bot's last reply in it. A reply to one of its messages carries an ended
 * session on anyway, for a day after its last turn.
 *
 * Every call for a channel runs inside its turn queue, so two turns never decide at once.
 */
export class ChatSessions {
    constructor(private readonly repo: SessionsRepo = chatSessionsRepo) {}

    /**
     * Which session `trigger` carries on. `repliedToId` is the bot's message it replies to, if
     * it replies to one; `botId` is whose messages are not activity.
     */
    async resolve(trigger: Message<true>, botId: string, repliedToId: string | null, now: Date = new Date()): Promise<ResolvedSession> {
        if (repliedToId) {
            const replied = await this.repo.findByPost(trigger.guildId, repliedToId);
            // A post moved with its thread, or a session swept late, is no session of this channel's.
            if (replied && replied.channelId === trigger.channelId && now.getTime() - replied.lastActiveAt.getTime() < SESSION_REVIVAL_MS) {
                return this.withTurns(replied);
            }
        }
        const latest = await this.repo.findLatestInChannel(trigger.guildId, trigger.channelId);
        if (!latest || now.getTime() - latest.lastActiveAt.getTime() >= SESSION_IDLE_MS) return NEW_SESSION;
        const since = await messagesSince(trigger, latest.lastPostId, botId);
        return since < SESSION_ACTIVITY_LIMIT ? this.withTurns(latest) : NEW_SESSION;
    }

    /** Records a turn that posted, then sweeps (`sweep`), whose failure is its own and only logged. */
    async record(input: RecordSessionTurnInput): Promise<void> {
        await this.repo.recordTurn({ ...input, keepTurns: MAX_TURNS_PER_SESSION });
        await this.sweep(input.now).catch((error: unknown) => console.error('[chat-agent] could not sweep ended sessions:', error));
    }

    /**
     * Deletes every session past its day, with its turns and posts: a session's stored questions
     * and results — staff-only pages included — are kept no longer than it can be revived. Run as
     * each turn records, and every {@link SESSION_SWEEP_INTERVAL_MS} (`initChatAgent`) for a
     * server that has gone quiet.
     */
    async sweep(now: Date = new Date()): Promise<void> {
        await this.repo.deleteInactiveSince(new Date(now.getTime() - SESSION_REVIVAL_MS));
    }

    /**
     * Forgets the turns that answered or posted any of `messageIds`, deleted in Discord: what
     * people took back is not replayed to the model for a day. (`sessionMemory` also drops a
     * turn whose message is missing from inside the window, for a delete this never heard.)
     */
    async forgetDeleted(guildId: string, messageIds: readonly string[]): Promise<void> {
        await this.repo.deleteTurnsTouching(guildId, messageIds);
    }

    private async withTurns(session: ChatSession): Promise<ResolvedSession> {
        return { id: session.id, turns: await this.repo.listTurns(session.id) };
    }
}

/** What one of the bot's answers adds to its session. */
export type SessionTurnSource = {
    readonly history: readonly HistoryMessage[];
    readonly context: Pick<ChatToolContext, 'asker' | 'viewers'>;
    /** The model that wrote `messages`. */
    readonly modelId: string;
    readonly messages: readonly ModelMessage[];
    /** What posted: the reply's parts as sent, and the ids of those that landed. */
    readonly posted: { readonly parts: readonly string[]; readonly ids: readonly string[] };
};

/**
 * The session turn for an answer: the question it answered (the marked history message, which
 * `readChannelHistory` always includes), what posted, its model messages — their last text
 * made what was posted, so a replay never shows the model a reply nobody saw — the model that
 * wrote them, its readers and every channel all of them could see.
 *
 * The answer is the parts that landed, their links turned back into names (`unlinkReferences`),
 * as the model is shown everything. Throws when the history has no marked message: the turn
 * would be recorded unaskable.
 */
export function sessionTurnFrom(source: SessionTurnSource): NewSessionTurn {
    const { history, context, posted } = source;
    const answered = history.find((message) => message.isBeingAnswered);
    if (!answered) throw new Error('The history of a turn being recorded has no message marked as answered');
    const answer = unlinkReferences(posted.parts.slice(0, posted.ids.length).join('\n'), context.viewers[0].guild);
    return {
        askerId: context.asker.id,
        questionId: answered.id,
        question: formatQuestion(answered),
        answer,
        messages: withFinalText(source.messages, answer),
        model: source.modelId,
        readerIds: context.viewers.map((viewer) => viewer.id),
        visibleChannelIds: listVisibleChannels(context.viewers).map((channel) => channel.id),
        postIds: posted.ids,
    };
}

/** `messages` ending on `text` as the assistant's last word: its final text replaced, or added when the turn ended on a tool. */
function withFinalText(messages: readonly ModelMessage[], text: string): ModelMessage[] {
    const last = messages.at(-1);
    const finalText: ModelMessage = { role: 'assistant', content: [{ type: 'text', text }] };
    if (last?.role !== 'assistant') return [...messages, finalText];
    const calls = typeof last.content === 'string' ? [] : last.content.filter((part) => part.type !== 'text' && part.type !== 'reasoning');
    // A final step that also called a tool keeps its calls, which their results follow nowhere: drop them with its text.
    return calls.length > 0 ? [...messages, finalText] : [...messages.slice(0, -1), finalText];
}

/**
 * How many messages anyone but the bot posted in the channel after `afterId` and before
 * `trigger`: what a turn kept waiting in the queue missed does not end the session it is in.
 */
async function messagesSince(trigger: Message<true>, afterId: string, botId: string): Promise<number> {
    const after = await trigger.channel.messages.fetch({ after: afterId, limit: ACTIVITY_READ_LIMIT });
    return after.filter((message) => message.author.id !== botId && BigInt(message.id) < BigInt(trigger.id)).size;
}
