/**
 * Deciding when the builder writes the canvas to the operator's draft, and what the
 * toolbar says about it.
 *
 * Pure, and split from `useFlowDraftAutosave` for the reason `resourceSaveQueue.ts` is
 * split from its hook: the decisions are sequencing, and sequencing inside a component
 * is what the suite cannot see. The hook is the timer and the refs; every judgement it
 * makes is one of these.
 *
 * ## What a draft autosave must not do
 *
 *  - **Write during a load.** A flow — or a draft picked from the list — arriving on the
 *    canvas is not an edit. The canvas is compared against what was loaded (the
 *    *baseline*), and until a load has set one there is nothing to compare against, so
 *    nothing is sent.
 *  - **Write what is already stored.** A canvas back where it was loaded — undo to the
 *    start — is not unsaved work, and neither is one that matches what was last sent.
 *  - **Claim someone else's draft as mine unprompted.** Loading `@alice's draft` sets
 *    the baseline to *her* graph, so it is only written to my draft once I change it.
 *  - **Race a save.** While the flow save is in flight the autosave holds; the save's
 *    answer decides what the draft should hold.
 */

import type { FlowDraftSummary, FlowGraph } from '../api/types';

/**
 * How long editing must pause before the canvas is written to the draft.
 *
 * Longer than the resource list's 600ms because this sends the whole graph and nothing
 * on screen waits on it: a draft is insurance against leaving, and the page's unmount
 * flushes whatever the debounce was holding, so the only thing a long pause can lose is
 * a crash's worth of work.
 */
export const DRAFT_AUTOSAVE_DEBOUNCE_MS = 2000;

/** What goes into a draft: the canvas, and the name box — a rename is unsaved work too. */
export interface FlowDraftPayload {
    readonly name: string;
    readonly graph: FlowGraph;
}

export interface DraftAutosaveDecisionInput {
    /** The canvas as it stands, serialised. */
    readonly current: string;
    /** What the canvas was loaded or last persisted as; `undefined` until a load lands. */
    readonly baseline: string | undefined;
    /** What was last written to the operator's draft from this page, if anything. */
    readonly lastSent: string | undefined;
    /** A flow save is in flight, and its answer is what the draft should follow. */
    readonly paused: boolean;
}

/** Whether the canvas should be written to the operator's draft. See the module header. */
export function shouldAutosaveDraft({ current, baseline, lastSent, paused }: DraftAutosaveDecisionInput): boolean {
    if (paused || baseline === undefined) return false;
    if (current === baseline) return false;
    return current !== lastSent;
}

/** What the operator's draft is known to hold, as far as this page knows. */
export type DraftAutosaveState =
    | { readonly kind: 'idle' }
    | { readonly kind: 'saved'; readonly at: string }
    /** The last write was refused or never arrived. The next edit tries again. */
    | { readonly kind: 'failed' };

export interface BuilderStatusInput {
    /** The canvas differs from the saved flow. */
    readonly dirty: boolean;
    readonly draft: DraftAutosaveState;
    /**
     * The last save landed on the operator's draft only, because the flow is live and the
     * graph incomplete. Persisted, so not dirty — but not live either, and the toolbar has
     * to say which.
     */
    readonly savedAsDraftOnly: boolean;
}

export interface BuilderStatus {
    readonly text: string;
    /** `attention` for the two states an operator may need to act on. */
    readonly tone: 'clean' | 'dirty' | 'attention';
}

/**
 * The toolbar's status line. Terse on purpose: it sits beside the controls and is read
 * at a glance, so it says which state the work is in and, when there is a draft, when
 * it was last kept.
 *
 * @param now - For the time format; see {@link formatWhen}.
 */
export function builderStatusLine({ dirty, draft, savedAsDraftOnly }: BuilderStatusInput, now: Date): BuilderStatus {
    if (dirty) {
        switch (draft.kind) {
            case 'saved':
                return { text: `Unsaved changes · draft saved ${formatWhen(draft.at, now)}`, tone: 'dirty' };
            case 'failed':
                return { text: 'Unsaved changes · draft not saved', tone: 'attention' };
            case 'idle':
                return { text: 'Unsaved changes', tone: 'dirty' };
        }
    }
    if (savedAsDraftOnly) {
        return { text: 'Draft saved — live flow unchanged', tone: 'attention' };
    }
    return { text: 'All changes saved', tone: 'clean' };
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

/**
 * `12:04` today, `28 Sep, 12:04` any other day — in the browser's local time.
 *
 * Written out rather than left to `toLocaleTimeString`, whose output varies by runtime
 * and locale; the status line and the picker should read the same everywhere, and a
 * test should be able to say what they read.
 */
export function formatWhen(iso: string, now: Date): string {
    const when = new Date(iso);
    const time = `${String(when.getHours()).padStart(2, '0')}:${String(when.getMinutes()).padStart(2, '0')}`;
    const sameDay =
        when.getFullYear() === now.getFullYear() &&
        when.getMonth() === now.getMonth() &&
        when.getDate() === now.getDate();
    return sameDay ? time : `${when.getDate()} ${MONTHS[when.getMonth()]}, ${time}`;
}

/** What the picker calls a draft: "Your draft", or "@alice's draft". */
export function draftLabel(draft: Pick<FlowDraftSummary, 'mine' | 'authorName'>): string {
    return draft.mine ? 'Your draft' : `@${draft.authorName}'s draft`;
}

/**
 * The picker's order: the operator's own draft first — it is the likeliest one they came
 * back for — then everyone else's in the order the server sent them, which is most
 * recently edited first.
 */
export function orderDraftsForPicker<TDraft extends Pick<FlowDraftSummary, 'mine'>>(
    drafts: readonly TDraft[]
): TDraft[] {
    return [...drafts.filter((draft) => draft.mine), ...drafts.filter((draft) => !draft.mine)];
}

/**
 * The notification for a save that landed on the draft only.
 *
 * Says what did not happen as plainly as what did: the operator pressed Save on a live
 * flow, and the natural assumption is that members now get the new version. Names both
 * things that can hold a graph back — problems on the canvas, and picked resources not
 * in the server yet — since either alone is enough and the fix for each is different.
 */
export function draftOnlySaveMessage(problems: number, uninstalled: readonly string[]): string {
    const until: string[] = [];
    if (problems > 0) {
        until.push(problems === 1 ? 'this problem is fixed' : `these ${problems} problems are fixed`);
    }
    if (uninstalled.length > 0) {
        const named = uninstalled.map((key) => `"${key}"`).join(', ');
        until.push(`${named} ${uninstalled.length === 1 ? 'is' : 'are'} installed`);
    }
    return `Saved as a draft only — the live flow keeps running the last working version until ${until.join(' and ')}.`;
}
