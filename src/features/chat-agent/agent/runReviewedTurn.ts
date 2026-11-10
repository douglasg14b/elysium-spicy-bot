import type { ModelMessage } from 'ai';
import { redoInstruction, reviewReply, type ReplyProblem, type ReviewContext } from '../output/replyReview';
import { runChatTurn, type ChatTurnInput, type ChatTurnResult } from './runChatTurn';

/** A turn after the output controls: what to post, if anything, and the model turn behind it. */
export type ReviewedTurn =
    /** The agent chose silence (`stayQuiet`), or a ticket reply came out empty or as a written tool call. */
    | { readonly outcome: 'quiet'; readonly turn: ChatTurnResult; readonly redone: RedoNote | null }
    /** Still wrong after a redo: the caller posts its fallback line, or nothing in a ticket. */
    | { readonly outcome: 'fallback'; readonly turn: ChatTurnResult; readonly redone: RedoNote; readonly problems: readonly ReplyProblem[] }
    | {
          readonly outcome: 'post';
          readonly turn: ChatTurnResult;
          /** The reply as fixed, before links. */
          readonly text: string;
          readonly parts: readonly [string, ...string[]];
          readonly redone: RedoNote | null;
      };

/** Why the first reply was turned back, and the turn that wrote it. */
export type RedoNote = { readonly problems: readonly ReplyProblem[]; readonly first: ChatTurnResult };

/**
 * One chat turn through the output controls (`output/replyReview.ts`): the model answers;
 * what code can fix is fixed; a reply still wrong is turned back once with the reason — the
 * model sees its own reply, then why it was not posted — and a second wrong one is a fallback.
 *
 * The redo is a second full turn on the same conversation, tools and all, so it can look up
 * the channel it got wrong. `turn` is always the turn whose reply is posted.
 */
export async function runReviewedTurn(input: ChatTurnInput, review: ReviewContext): Promise<ReviewedTurn> {
    const first = await runChatTurn(input);
    if (first.stayedQuiet) return { outcome: 'quiet', turn: first, redone: null };
    const firstReview = reviewReply(first.text, review, 'first');
    switch (firstReview.verdict) {
        case 'quiet':
            return { outcome: 'quiet', turn: first, redone: null };
        case 'post':
            return { outcome: 'post', turn: first, text: firstReview.text, parts: firstReview.parts, redone: null };
        case 'redo':
            break;
    }

    const redone: RedoNote = { problems: firstReview.problems, first };
    const messages: ModelMessage[] = [
        ...input.messages,
        ...first.responseMessages,
        { role: 'user', content: redoInstruction(firstReview.problems) },
    ];
    const second = await runChatTurn({ ...input, messages });
    if (second.stayedQuiet) return { outcome: 'quiet', turn: second, redone };
    const lastReview = reviewReply(second.text, review, 'last');
    switch (lastReview.verdict) {
        case 'quiet':
            return { outcome: 'quiet', turn: second, redone };
        case 'post':
            return { outcome: 'post', turn: second, text: lastReview.text, parts: lastReview.parts, redone };
        case 'fallback':
            return { outcome: 'fallback', turn: second, redone, problems: lastReview.problems };
    }
}
