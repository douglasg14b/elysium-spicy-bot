/**
 * Write the builder's canvas to the operator's draft once editing pauses, and flush it
 * when the page goes away.
 *
 * The effect machinery only — every decision is `flowDraftAutosave.ts`'s, which the suite
 * drives directly. What is left needs a live component: a timer, refs holding what was
 * loaded and what was sent, and an unmount flush. Modelled on `useResourceAutosave`, and
 * for the same reason kept this thin.
 *
 * **It never disables anything.** There is no "saving" flag here for a control to spread
 * onto itself: an input disabled while it has focus loses it (HTML's focus fixup rule),
 * which is how the resources panel once ate every other keystroke. The only thing this
 * reports is {@link DraftAutosaveState}, and only the status line reads it.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { saveMyFlowDraft } from '../api/flows';
import { shouldAcceptResponse } from './resourceSaveQueue';
import {
    DRAFT_AUTOSAVE_DEBOUNCE_MS,
    shouldAutosaveDraft,
    shouldFlushDraft,
    type DraftAutosaveState,
    type FlowDraftPayload,
} from './flowDraftAutosave';

interface FlowDraftAutosaveInput {
    /** Undefined until a guild is selected; nothing is sent before then. */
    readonly guildId: string | undefined;
    readonly flowId: string | undefined;
    /** The canvas as it stands. Memoise it: a new object per render re-serialises per render. */
    readonly payload: FlowDraftPayload;
    /**
     * The flow version the canvas descends from — see `saveMyFlowDraft`. Sent with each
     * write but kept out of the comparison: it moves when a save lands, and a canvas is
     * not edited by the flow it came from being saved. Nothing is sent while unknown.
     */
    readonly baseUpdatedAt: string | undefined;
    /** A flow save is in flight; hold until it answers. */
    readonly paused: boolean;
}

export interface FlowDraftAutosave {
    readonly state: DraftAutosaveState;
    /**
     * The next canvas this sees is a load, not an edit: take it as the baseline and send
     * nothing. Called just before a flow, or a draft picked from the list, is put on the
     * canvas. `mineSavedAt` says the canvas being loaded *is* the operator's own draft, as
     * stored at that time — so it is already sent, and the status line can say so.
     */
    readonly rebase: (options?: { readonly mineSavedAt?: string }) => void;
    /** `payload` was just kept as the operator's draft by a save that landed there. */
    readonly markDrafted: (payload: FlowDraftPayload, savedAt: string) => void;
    /** `payload` was just saved to the flow, which removed the operator's draft. */
    readonly markSavedToFlow: (payload: FlowDraftPayload) => void;
    /**
     * The operator discarded `payload` and deleted their draft with it. Taken as the
     * baseline, so leaving afterwards does not flush the discarded canvas straight back.
     */
    readonly markDiscarded: (payload: FlowDraftPayload) => void;
    /**
     * Drop any write still waiting on the debounce, and resolve once one already sent has
     * answered. Save calls this first: a draft write reaching the server after the save
     * has deleted the draft would put it straight back, offering the operator their own
     * saved work as unfinished business on the next open.
     */
    readonly settle: () => Promise<void>;
    /**
     * Write the canvas to the draft now rather than after the debounce, and resolve with
     * whether the draft holds it. `true` without a write when it already does, or when there
     * is nothing to keep (see `shouldFlushDraft`), and `false` when the write failed.
     */
    readonly flush: () => Promise<boolean>;
}

export function useFlowDraftAutosave({
    guildId,
    flowId,
    payload,
    baseUpdatedAt,
    paused,
}: FlowDraftAutosaveInput): FlowDraftAutosave {
    const [state, setState] = useState<DraftAutosaveState>({ kind: 'idle' });

    /** Which flow the refs below describe. A draft is only ever written to this one. */
    const identity = `${guildId ?? ''}/${flowId ?? ''}`;
    const serialised = useMemo(() => JSON.stringify(payload), [payload]);

    /** What the canvas was loaded or last persisted as. See `shouldAutosaveDraft`. */
    const baselineRef = useRef<string | undefined>(undefined);
    /**
     * Which flow `baselineRef` belongs to. `/flows/:flowId` re-renders rather than
     * remounts when the id changes, so for one render the new id sits beside the old
     * canvas — and without this that canvas would read as an edit of the new flow.
     */
    const baselineIdentityRef = useRef<string | undefined>(undefined);
    const lastSentRef = useRef<string | undefined>(undefined);
    /** Set by `rebase`; the next canvas seen becomes the baseline. */
    const pendingRebaseRef = useRef<{ mineSavedAt?: string } | null>(null);
    /**
     * Bumped by `rebase`, so the effect runs even when the canvas being loaded serialises
     * exactly like the one it replaces. Without it the rebase would wait for the next
     * change — and swallow the operator's first edit as the baseline.
     */
    const [rebaseTick, setRebaseTick] = useState(0);
    /** Monotonic request number, for the reason `shouldAcceptResponse` gives. */
    const issuedRef = useRef(0);
    /** The debounce waiting to write, so `settle` can drop it. */
    const timerRef = useRef<number | undefined>(undefined);
    /**
     * The last write queued, until it answers. Resolves `true` if it landed. Writes queue
     * behind each other, so waiting on this waits for every one of them.
     */
    const inFlightRef = useRef<Promise<boolean> | null>(null);

    const latestRef = useRef({ payload, serialised, baseUpdatedAt, paused });
    latestRef.current = { payload, serialised, baseUpdatedAt, paused };

    /** Write `next` to the operator's draft. Resolves `true` if it landed; never rejects. */
    const send = useCallback(
        (next: FlowDraftPayload, nextSerialised: string): Promise<boolean> => {
            const base = latestRef.current.baseUpdatedAt;
            if (!guildId || !flowId || !base) return Promise.resolve(false);
            const sentFor = identity;
            lastSentRef.current = nextSerialised;
            issuedRef.current += 1;
            const issued = issuedRef.current;
            // A response for another flow, or one a newer write has overtaken, is dropped:
            // it describes a draft that is no longer the one on screen.
            const stillCurrent = () => baselineIdentityRef.current === sentFor && shouldAcceptResponse(issued, issuedRef.current);

            // One write on the wire at a time, behind the last. Side by side, a slow write
            // could land after a newer one and leave the draft holding the older canvas —
            // or land after a discard's delete and put the draft back. Queued, the server
            // stores them in the order they were made, and `settle` waits for all of them.
            const queue = inFlightRef.current ?? Promise.resolve(true);
            const request = queue
                .then(() => saveMyFlowDraft(guildId, flowId, { ...next, baseUpdatedAt: base }))
                .then((stored) => {
                    if (stillCurrent()) setState({ kind: 'saved', at: stored.updatedAt });
                    return true;
                })
                .catch(() => {
                    if (!stillCurrent()) return false;
                    // Forgotten, so the next edit is sent even if it lands back on what
                    // this one tried to send. Shown on the status line, and only there:
                    // a notification per failed autosave would be one per pause in typing.
                    lastSentRef.current = undefined;
                    setState({ kind: 'failed' });
                    return false;
                })
                .finally(() => {
                    if (inFlightRef.current === request) inFlightRef.current = null;
                });
            inFlightRef.current = request;
            return request;
        },
        [guildId, flowId, identity]
    );

    useEffect(() => {
        const pending = pendingRebaseRef.current;
        if (pending) {
            pendingRebaseRef.current = null;
            baselineRef.current = serialised;
            baselineIdentityRef.current = identity;
            lastSentRef.current = pending.mineSavedAt ? serialised : undefined;
            setState(pending.mineSavedAt ? { kind: 'saved', at: pending.mineSavedAt } : { kind: 'idle' });
            return;
        }
        if (baselineIdentityRef.current !== identity) return;

        if (
            !shouldAutosaveDraft({
                current: serialised,
                baseline: baselineRef.current,
                lastSent: lastSentRef.current,
                paused,
            })
        ) {
            return;
        }

        // Read from the ref when it fires, and not a dependency: the payload object is
        // rebuilt by changes that serialise the same (a selection, a card's issue count),
        // and restarting the debounce on each would be a timer that never fires.
        const handle = window.setTimeout(() => {
            timerRef.current = undefined;
            void send(latestRef.current.payload, latestRef.current.serialised);
        }, DRAFT_AUTOSAVE_DEBOUNCE_MS);
        timerRef.current = handle;
        return () => {
            window.clearTimeout(handle);
            if (timerRef.current === handle) timerRef.current = undefined;
        };
    }, [serialised, paused, identity, send, rebaseTick]);

    /**
     * Flush on unmount — and on moving to another flow — so leaving mid-pause does not
     * drop the last edit. Subscribed per flow, not per edit, so the cleanup runs when the
     * page goes rather than on every keystroke; the canvas is read from a ref.
     */
    useEffect(() => {
        const watching = identity;
        return () => {
            const { payload: pending, serialised: pendingSerialised, paused: saving } = latestRef.current;
            if (baselineIdentityRef.current !== watching) return;
            if (
                !shouldAutosaveDraft({
                    current: pendingSerialised,
                    baseline: baselineRef.current,
                    lastSent: lastSentRef.current,
                    paused: saving,
                })
            ) {
                return;
            }
            void send(pending, pendingSerialised);
        };
    }, [identity, send]);

    const rebase = useCallback((options: { readonly mineSavedAt?: string } = {}) => {
        // Anything in flight describes the canvas being replaced.
        issuedRef.current += 1;
        pendingRebaseRef.current = { mineSavedAt: options.mineSavedAt };
        setRebaseTick((tick) => tick + 1);
    }, []);

    const markDrafted = useCallback((persisted: FlowDraftPayload, savedAt: string) => {
        issuedRef.current += 1;
        const stored = JSON.stringify(persisted);
        baselineRef.current = stored;
        lastSentRef.current = stored;
        setState({ kind: 'saved', at: savedAt });
    }, []);

    /** Behind both `markSavedToFlow` and `markDiscarded`: the draft is gone, and `persisted` is the canvas it went with. */
    const markDraftGone = useCallback((persisted: FlowDraftPayload) => {
        issuedRef.current += 1;
        baselineRef.current = JSON.stringify(persisted);
        // The draft was deleted, so nothing is stored there to match against.
        lastSentRef.current = undefined;
        setState({ kind: 'idle' });
    }, []);

    const dropPendingWrite = useCallback(() => {
        if (timerRef.current !== undefined) {
            window.clearTimeout(timerRef.current);
            timerRef.current = undefined;
        }
    }, []);

    const settle = useCallback(async (): Promise<void> => {
        dropPendingWrite();
        await inFlightRef.current;
    }, [dropPendingWrite]);

    const flush = useCallback(async (): Promise<boolean> => {
        dropPendingWrite();
        // A write already on its way is waited for rather than raced: if it lands, the
        // canvas may be exactly what it sent, and if it fails it has forgotten `lastSent`,
        // so the check below sends again.
        await inFlightRef.current;
        const { payload: pending, serialised: pendingSerialised } = latestRef.current;
        if (baselineIdentityRef.current !== identity) return false;
        if (
            !shouldFlushDraft({
                current: pendingSerialised,
                baseline: baselineRef.current,
                lastSent: lastSentRef.current,
            })
        ) {
            return true;
        }
        return send(pending, pendingSerialised);
    }, [dropPendingWrite, identity, send]);

    return {
        state,
        rebase,
        markDrafted,
        markSavedToFlow: markDraftGone,
        markDiscarded: markDraftGone,
        settle,
        flush,
    };
}
