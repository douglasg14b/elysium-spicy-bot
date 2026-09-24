/**
 * Write the declaration list to the server once editing pauses.
 *
 * The effect machinery only — every *decision* it takes is imported from
 * `resourceSaveQueue.ts`, which the suite can drive. What is left here is the part that
 * genuinely needs a live component: a timer, a ref holding the last list actually sent,
 * and an unmount flush. Keeping it this thin is deliberate. The bug this replaced was
 * invisible to the suite precisely because the sequencing lived inside a component.
 *
 * See `resourceSaveQueue.ts` for the bug and the rule; this file is its wiring.
 */

import { useCallback, useEffect, useMemo, useRef } from 'react';
import { notifications } from '@mantine/notifications';
import { ApiError } from '../api/client';
import type { ResourceDeclaration } from '../api/types';
import {
    decideAutosaveAction,
    describeSaveFailure,
    isWorthSaving,
    RESOURCE_SAVE_DEBOUNCE_MS,
    shouldAcceptResponse,
} from './resourceSaveQueue';
import {
    loadResources,
    resourceTargetIdentity,
    storeResources,
    type ResourceSaveTarget,
} from './resourceSaveTarget';

interface ResourceAutosaveInput {
    /** Undefined until a guild is selected; nothing is sent before then. */
    guildId: string | undefined;
    /**
     * Which endpoint this list is written to — a flow, or a journey directly.
     *
     * `undefined` before the caller knows, which is the builder's state while the route
     * parameter is still being read. Nothing is sent until it is set.
     *
     * Replaced the previous `flowId` + `journeyKey` pair, which were two fields expressing
     * one concept: the first said where to write and the second was only ever part of the
     * bookkeeping identity. See `resourceSaveTarget.ts` for why the two surfaces cannot
     * share one endpoint.
     */
    target: ResourceSaveTarget | undefined;
    /**
     * The journey the current list belongs to, or `undefined` while it is unknown or the
     * flow is attached to nothing.
     *
     * Part of the save bookkeeping's identity, not a label, and still needed alongside a
     * `flow` target: attaching a flow to another journey replaces the list on screen
     * without the flow id changing, and the effect would otherwise read the replacement as
     * an edit and write it into the journey just attached to. See
     * `AutosaveDecisionInput.identity`.
     *
     * Redundant for a `journey` target, where it is the same key the target names — and
     * harmless, because it then contributes a constant to the identity string.
     */
    journeyKey: string | undefined;
    resources: ResourceDeclaration[];
    /**
     * Whether the initial fetch has finished.
     *
     * Without this the empty list held before the first load would be saved over the
     * stored one — an autosave that deletes what it was meant to protect, on open.
     */
    loaded: boolean;
    onSaved: (resources: ResourceDeclaration[]) => void;
    onSavingChange: (saving: boolean) => void;
    onError: (message: string | null) => void;
}

export function useResourceAutosave({
    guildId,
    target,
    journeyKey,
    resources,
    loaded,
    onSaved,
    onSavingChange,
    onError,
}: ResourceAutosaveInput): void {
    /**
     * What the list on screen describes, as one string.
     *
     * Built once and used by all three places that need it — the send, the effect and
     * the unmount flush — because they must agree. Two of them deriving it separately is
     * how the flow-navigation bug in `baselineFlowRef` became possible in the first
     * place.
     *
     * A flow attached to nothing contributes an empty segment rather than being omitted,
     * so `guild/flow:abc/` and `guild/flow:abc/onboarding` are distinguishable.
     *
     * The target segment carries its **kind** as well as its id — see
     * `resourceTargetIdentity`. A flow id and the key of its implicit journey are the same
     * string, so without the prefix the builder's target and the group header's would
     * collide and one surface's stored list would be read as an edit of the other's.
     */
    const identity = `${guildId}/${target ? resourceTargetIdentity(target) : ''}/${journeyKey ?? ''}`;
    /**
     * The list as the server last confirmed it, or `undefined` for "send the next edit
     * whatever it looks like".
     *
     * Compared by value against the current list to decide whether there is anything to
     * send. A ref rather than state because changing it must not itself re-render: this
     * is bookkeeping about a request, not something drawn.
     *
     * **This is deliberately not also the "have we loaded yet" flag.** It was, and that
     * conflation was a bug: the failure path clears it to force the next edit to be sent,
     * but the load path read the same `undefined` as "first sight of this flow — record
     * and send nothing". So the first edit after a rejected save was silently swallowed,
     * and no request was ever issued for it. `baselineFlowRef` now answers "have we
     * loaded", and this answers only "what did the server last confirm".
     */
    const savedRef = useRef<string | undefined>(undefined);

    /** Monotonic request number. See `shouldAcceptResponse` for why this is not a diff. */
    const issuedRef = useRef(0);

    /** Kept in a ref so the flush-on-unmount effect does not re-subscribe per keystroke. */
    const latestRef = useRef(resources);
    latestRef.current = resources;

    /**
     * Which flow `savedRef` describes.
     *
     * Without this, navigating between two flows of the same guild reuses the baseline
     * from the previous one: the incoming flow's freshly loaded list is compared against
     * the *outgoing* flow's, differs, and is saved straight back — writing one flow's
     * declarations over another's without an edit having happened. The bookkeeping has to
     * be invalidated by the thing it is bookkeeping about.
     */
    const baselineFlowRef = useRef<string | undefined>(undefined);

    const callbacksRef = useRef({ onSaved, onSavingChange, onError });
    callbacksRef.current = { onSaved, onSavingChange, onError };

    /**
     * The target, pinned to one object per distinct target.
     *
     * **This is load-bearing, not tidiness.** `target` is an object and both callers build
     * it inline, so it is a fresh reference every render. Used directly as a `useCallback`
     * dependency it would rebuild `send` on each render, which rebuilds the effect below,
     * whose cleanup clears the pending `setTimeout` — the debounce would be reset by every
     * render and the save would never fire at all. That is a silent, total loss of
     * persistence, and no typecheck or existing test would notice it: the sequencing suite
     * drives the pure decisions in `resourceSaveQueue.ts` rather than this effect.
     *
     * Keying the memo on `identity` rather than on the object is what fixes it, and it is
     * exact rather than approximate: `identity` is built by `resourceTargetIdentity`, which
     * *is* the canonical serialisation of this object, so two targets share a reference here
     * precisely when they name the same endpoint.
     *
     * **It also has to be a value and not a ref.** A ref is written during render and read
     * by the unmount flush during *cleanup*, which runs afterwards — so on the commit that
     * changes the target, the flush watching the old identity would resolve its endpoint
     * from the *new* target while carrying the old target's list. That writes one surface's
     * declarations to another: the failure `baselineFlowRef` exists to prevent, arriving by
     * a different door. A memo is captured by the closure that `identity` also built, so the
     * two cannot disagree by construction.
     */
    const stableTarget = useMemo(
        () => target,
        // Deliberately keyed on the identity string rather than on the object. `identity`
        // *is* the canonical serialisation of `target` (`resourceTargetIdentity`), so this
        // holds one object per distinct target and re-renders that merely rebuild an equal
        // one get the same reference back.
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [identity]
    );

    const send = useCallback(
        (next: ResourceDeclaration[]) => {
            if (!guildId || !stableTarget) return;
            const target = stableTarget;

            const serialised = JSON.stringify(next);
            savedRef.current = serialised;

            issuedRef.current += 1;
            const issued = issuedRef.current;

            /*
             * Which flow *and journey* this request belongs to — `identity`, captured
             * when `send` was created.
             *
             * **The request number alone is not enough, because it is not reset by
             * navigation.** `/flows/:flowId` is one route with no `key`, so moving
             * between two flows re-renders this component rather than remounting it and
             * every ref survives. A save issued for flow A that resolves after the switch
             * would otherwise look current — nothing newer has been issued — and
             * `onSaved` is an unscoped `setDeclaredResources`, so **flow A's declarations
             * would be written into flow B's panel**, and into B's storage on the next
             * edit. Checked in every callback below, not just the effect.
             *
             * The journey segment extends the same protection across an attach, which
             * swaps the list without the flow id moving.
             */
            const stillOnThisFlow = () => baselineFlowRef.current === identity;

            const { onSaved: saved, onSavingChange: savingChange, onError: error } =
                callbacksRef.current;

            savingChange(true);
            error(null);

            void storeResources(guildId, target, next)
                .then((stored) => {
                    // A response that a later edit has already superseded is dropped
                    // rather than applied. Applying it is the revert.
                    if (!stillOnThisFlow()) return;
                    if (!shouldAcceptResponse(issued, issuedRef.current)) return;
                    savedRef.current = JSON.stringify(stored);
                    saved(stored);
                })
                .catch((cause: unknown) => {
                    if (!stillOnThisFlow()) return;

                    const { showError, revertToStored } = describeSaveFailure(
                        issued,
                        issuedRef.current
                    );

                    // Superseded: the refusal describes a list that no longer exists, and
                    // the save of the newer one is already queued. Let that one speak.
                    if (!showError && !revertToStored) return;

                    error(cause instanceof ApiError ? cause.message : 'Could not save resources.');

                    // Forget what was sent, so the next edit is sent even if it happens
                    // to produce the same list the server just refused. Read by the effect
                    // as "send regardless", which is why the load test above is keyed on
                    // the flow rather than on this being set.
                    savedRef.current = undefined;

                    void loadResources(guildId, target).then((stored) => {
                        if (!stillOnThisFlow()) return;
                        if (!shouldAcceptResponse(issued, issuedRef.current)) return;
                        savedRef.current = JSON.stringify(stored);
                        saved(stored);
                    });
                })
                .finally(() => {
                    // Only the newest request owns the flag, and only while its flow is
                    // still the one on screen. An older or foreign request finishing would
                    // otherwise clear a spinner that belongs to a live save.
                    if (stillOnThisFlow() && issued === issuedRef.current) savingChange(false);
                });
        },
        // `stableTarget` is pinned to `identity`, so naming the identity names both.
        [guildId, identity, stableTarget]
    );

    useEffect(() => {
        // The pinned target, not the raw prop: this effect's cleanup clears the debounce
        // timer, so a dependency that changed every render would reset it every render.
        if (!loaded || !guildId || !stableTarget) return;

        const serialised = JSON.stringify(resources);

        const action = decideAutosaveAction({
            identity,
            baselineIdentity: baselineFlowRef.current,
            confirmed: savedRef.current,
            current: serialised,
        });

        if (action === 'wait') return;

        if (action === 'adoptBaseline') {
            // This flow-and-journey's stored list arriving, not an edit of it. Also the
            // path an attach takes: the list belongs to a journey this bookkeeping has
            // not seen, so it is recorded rather than sent back.
            baselineFlowRef.current = identity;
            savedRef.current = serialised;
            return;
        }

        // Mid-edit invalidity is normal and the chips already report it in place. Holding
        // means the save happens as soon as the row is sendable again, without a server
        // banner describing something half-typed.
        if (!isWorthSaving(resources)) return;

        const handle = window.setTimeout(() => send(resources), RESOURCE_SAVE_DEBOUNCE_MS);
        return () => window.clearTimeout(handle);
    }, [resources, loaded, guildId, identity, stableTarget, send]);

    /**
     * Flush on unmount, so closing the builder mid-pause does not drop the last edit.
     *
     * Empty deps on purpose: this must run when the page goes away, not whenever the
     * list changes, which is why the list is read from a ref. Re-subscribing per
     * keystroke would make the cleanup fire on every edit and send each one immediately —
     * the debounce undone by its own safety net.
     */
    useEffect(() => {
        // `identity` is captured at subscribe time, so the cleanup flushes to the flow
        // and journey it was watching. `send` closes over the same value and is
        // re-created when it changes, which is what makes this cleanup run *at* the
        // switch rather than after it.
        const watching = identity;

        return () => {
            const pending = latestRef.current;
            if (savedRef.current === undefined) return;
            // A baseline belonging to another flow — or to the journey this one was
            // attached to before — means nothing here was edited.
            if (baselineFlowRef.current !== watching) return;
            if (JSON.stringify(pending) === savedRef.current) return;

            /**
             * Leaving with a row the server would refuse.
             *
             * The whole list is unsendable, not just the offending row — a partial list
             * is a *deletion* of everything omitted, so sending the valid subset would be
             * worse than sending nothing. The debounced save has been holding, correctly,
             * and now there is no later keystroke to release it.
             *
             * Warned rather than swallowed. It is reachable only by deliberately clearing
             * a name or key and then navigating away — rows are seeded valid — but silent
             * loss of declarations is not something to leave to a red chip the operator
             * has already walked away from.
             *
             * A notification rather than `onError`: that message renders *inside* the
             * resources modal, which by now is unmounting along with everything else, so
             * setting it would be writing to a surface nobody can read. A toast outlives
             * the page being left.
             */
            if (!isWorthSaving(pending)) {
                notifications.show({
                    color: 'orange',
                    title: 'Some resources were not saved',
                    message:
                        'A resource was left without a name or key, so the list could not be stored. Reopen the flow to finish it.',
                });
                return;
            }

            send(pending);
        };
    }, [send, guildId, identity]);
}
