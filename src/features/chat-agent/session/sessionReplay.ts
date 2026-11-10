import type { ModelMessage } from 'ai';
import type { SessionTurn } from '../data/chatSessionsRepo';
import type { ChatToolContext } from '../tools/chatToolContext';
import { staffOnlyRefusal } from '../tools/staffAccess';
import { listVisibleChannels } from '../tools/visibleChannels';
import { NO_SESSION, type EarlierTurn, type HistoryMessage, type SessionMemory, type SessionPost } from './historyToModelMessages';
import { usesStaffOnlyTools } from './staffOnlyTrace';

/** What a replay checks a session's turns against: this turn's readers, and the model that will read them. */
export type ReplayContext = Pick<ChatToolContext, 'viewers' | 'staffRoleIds' | 'viewersCanReadHistory'> & {
    readonly modelId: string;
};

/**
 * What a session's turns add to this turn's history.
 *
 * Each tool result was checked against the readers of its turn, so a turn's trace is shown
 * again only while nothing about them has moved: **every reader now was a reader then**
 * (someone let in since never hears what was looked up for the others), every channel all of
 * them could see then they all still can (a role taken away takes its channels with it), and
 * — for a turn that asked a staff-only tool — every reader is still staff. And only to the
 * model that wrote it, since another may refuse its ids and fields. Otherwise the turn is its
 * question and answer, posted where everyone here can scroll to them.
 *
 * Discord is the source of truth for what was said: a turn whose question or post is missing
 * from inside the window was deleted, and is not shown at all — the delete listener drops it
 * from the session too (`initChatAgent`), this catches one it missed. A turn wholly older than
 * the window comes first; one in it is spliced in place of its reply. Where not every reader
 * can read the channel's history the agent is shown none of it (`readChannelHistory`), so
 * none of the session either.
 */
export function sessionMemory(turns: readonly SessionTurn[], history: readonly HistoryMessage[], context: ReplayContext): SessionMemory {
    const oldest = history[0];
    if (!context.viewersCanReadHistory || !oldest) return NO_SESSION;
    const inWindow = new Set(history.map((message) => message.id));
    const insideWindow = (id: string) => BigInt(id) >= BigInt(oldest.id);
    const deleted = (id: string) => insideWindow(id) && !inWindow.has(id);
    const visibleNow = new Set(listVisibleChannels(context.viewers).map((channel) => channel.id));
    const staffResultsShown = !staffOnlyRefusal(context);

    const posts = new Map<string, SessionPost>();
    const earlier: EarlierTurn[] = [];
    for (const turn of turns) {
        if (deleted(turn.questionId) || turn.postIds.some(deleted)) continue;
        const trace = replayableTrace(turn, context, visibleNow, staffResultsShown);
        const [first, ...rest] = turn.postIds.filter((id) => inWindow.has(id));
        if (!first) {
            earlier.push({ question: turn.question, answer: turn.answer, trace });
            continue;
        }
        // Not shown: its posts stay plain text in the history.
        if (!trace) continue;
        posts.set(first, { kind: 'traced', trace, question: turn.question, questionId: turn.questionId });
        for (const id of rest) posts.set(id, { kind: 'continuation', of: first });
    }
    return { postFor: (messageId) => posts.get(messageId), earlier };
}

function replayableTrace(
    turn: SessionTurn,
    context: ReplayContext,
    visibleNow: ReadonlySet<string>,
    staffResultsShown: boolean
): readonly ModelMessage[] | undefined {
    if (!turn.messages || turn.model !== context.modelId) return undefined;
    const readersThen = new Set(turn.readerIds);
    if (!context.viewers.every((viewer) => readersThen.has(viewer.id))) return undefined;
    // A channel deleted since is seen by nobody: what was said of it was seen by all of them then.
    const guildChannels = context.viewers[0].guild.channels.cache;
    if (!turn.visibleChannelIds.every((id) => !guildChannels.has(id) || visibleNow.has(id))) return undefined;
    // A staff-only lookup leaves traces beyond its results — what was asked, the steps between — so the turn goes whole.
    if (!staffResultsShown && usesStaffOnlyTools(turn.messages)) return undefined;
    return turn.messages;
}
