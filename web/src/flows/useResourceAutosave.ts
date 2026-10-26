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

import { useCallback, useEffect, useRef } from 'react';
import { notifications } from '@mantine/notifications';
import { ApiError, type ResourceDeclaration } from '@brattybot/web-sdk';
import {
    classifySaveFailure,
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
    type StoredResources,
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
     *
     * **May change under one {@link subject}**: the builder saves through the flow until the
     * flow is linked to its journey, then through the journey (`builderResourcesTarget`). That
     * is a different door into the same list, not a different list, so it moves nothing the
     * bookkeeping holds — see `targetsRef`.
     */
    target: ResourceSaveTarget | undefined;
    /**
     * Whose list this is, for the bookkeeping identity: the builder's flow, or the group
     * header's journey. Defaults to {@link target}, which is right wherever the two never part.
     *
     * The builder's list is *its flow's* through every door it saves by — and two builder tabs'
     * worth of flows on one journey are two lists on screen, which a journey target alone would
     * name the same.
     */
    subject?: ResourceSaveTarget;
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
     * The version `resources` was loaded at (`StoredResources.updatedAt`), read when the list
     * is first seen for this identity. After that the hook keeps its own copy, moved on by
     * each save's answer — see `versionsRef`.
     */
    updatedAt: string | null;
    /**
     * Whether the initial fetch has finished.
     *
     * Without this the empty list held before the first load would be saved over the
     * stored one — an autosave that deletes what it was meant to protect, on open.
     */
    loaded: boolean;
    /** The list as the server stored it, and the version it is now at. */
    onSaved: (stored: StoredResources) => void;
    onSavingChange: (saving: boolean) => void;
    onError: (message: string | null) => void;
}

export function useResourceAutosave({
    guildId,
    target,
    subject = target,
    journeyKey,
    resources,
    updatedAt,
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
     * The subject segment carries its **kind** as well as its id — see
     * `resourceTargetIdentity`. A flow id and the key of its implicit journey are the same
     * string, so without the prefix the builder's subject and the group header's would
     * collide and one surface's stored list would be read as an edit of the other's.
     *
     * Built from the **subject**, not the target, so the builder moving from the flow's door to
     * the journey's keeps one identity — and with it the version its last save answered with.
     */
    const identity = `${guildId}/${subject ? resourceTargetIdentity(subject) : ''}/${journeyKey ?? ''}`;
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

    /**
     * Each identity's journey version as the server last answered it, sent with that
     * identity's saves as `baseUpdatedAt`.
     *
     * Read when the queued request actually leaves rather than when it was queued: a second
     * save waits behind the first, and must carry the version the *first* one moved the
     * journey to, or the server would refuse it as stale. Moved on by **every** answer for an
     * identity, superseded ones included — the server stored that list, so its version is the
     * journey's now whether or not the screen adopts the list.
     *
     * **Keyed by identity, because requests outlive the screen.** Leaving flow A mid-save
     * queues A's flush behind A's save while the screen loads flow B; one shared version would
     * hold B's by the time A's flush left — a 409 for a save that was never stale, and the
     * edit dropped. So a request writes its own identity's version on success whether or not
     * the screen still shows it, and reads its own identity's when it leaves.
     */
    const versionsRef = useRef(new Map<string, string | null>());
    const latestVersionRef = useRef(updatedAt);
    latestVersionRef.current = updatedAt;

    /**
     * Identities whose journey moved on under this tab: a save of theirs got the stale-version
     * 409. Nothing more is sent for them — every save would be refused the same way — the
     * message telling the operator to reload stays up, and leaving with the edits unsaved says
     * so. Cleared only when the identity's stored list is loaded afresh (`adoptBaseline`).
     */
    const staleRef = useRef(new Set<string>());

    /**
     * The last write queued, until it settles. Writes go one at a time, behind it, as the
     * draft autosave's do: each sends the whole list, so a list the server stored after a
     * newer one would delete what the newer one added. Side by side that needs only two
     * writes on separate connections answered out of order — which is exactly what a lost
     * session sets up, holding both and releasing them together once the operator is back.
     */
    const queueRef = useRef<Promise<void>>(Promise.resolve());

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
     * The endpoint each identity saves through, as last rendered, read when a request leaves.
     *
     * **Not a dependency of anything, and that is load-bearing.** `target` is an object both
     * callers build inline, so a fresh reference every render; as a `useCallback` dependency it
     * would rebuild `send` on each render, which rebuilds the effect below, whose cleanup clears
     * the pending `setTimeout` — the debounce would be reset by every render and the save would
     * never fire at all. A silent, total loss of persistence no typecheck would notice.
     *
     * **Keyed by identity, never one shared slot.** The unmount flush runs during *cleanup*,
     * after the render that moved on, so a single "current target" would hand the flush
     * watching the old identity the *new* identity's endpoint while it carries the old list —
     * one surface's declarations written to another, the failure `baselineFlowRef` exists to
     * prevent. Keyed by identity, a flush can only ever find its own identity's door.
     *
     * **Read as the request leaves**, as the version is: the builder moves from the flow's door
     * to the journey's under one identity once the flow is linked (`target`), and a save queued
     * behind the one that linked it goes through the journey with the version that one answered.
     */
    const targetsRef = useRef(new Map<string, ResourceSaveTarget>());
    if (target) targetsRef.current.set(identity, target);
    const hasTarget = target !== undefined;

    const send = useCallback(
        (next: ResourceDeclaration[]) => {
            const queuedTarget = targetsRef.current.get(identity);
            if (!guildId || !queuedTarget) return;
            // This identity's door when the request leaves, which may have moved since it was queued.
            const endpoint = () => targetsRef.current.get(identity) ?? queuedTarget;

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

            // The version is read as the request leaves, behind the one before it, and it is
            // this request's identity's: see `versionsRef`.
            const request = queueRef.current.then(() =>
                storeResources(guildId, endpoint(), next, versionsRef.current.get(identity) ?? null)
            );
            queueRef.current = request.then(
                () => undefined,
                () => undefined
            );

            void request
                .then((stored) => {
                    // Before both checks: the journey is at this version now whether or not
                    // the screen still shows it, or takes the list — and a flush of this
                    // identity may already be queued behind this request.
                    versionsRef.current.set(identity, stored.updatedAt);
                    if (!stillOnThisFlow()) return;
                    // A response that a later edit has already superseded is dropped
                    // rather than applied. Applying it is the revert.
                    if (!shouldAcceptResponse(issued, issuedRef.current)) return;
                    savedRef.current = JSON.stringify(stored.resources);
                    saved(stored);
                })
                .catch((cause: unknown) => {
                    const { showError, revertToStored, markStale } = describeSaveFailure(
                        issued,
                        issuedRef.current,
                        cause instanceof ApiError ? classifySaveFailure(cause.status, cause.message) : 'other'
                    );
                    // Whichever screen is up: the journey has moved on under this identity.
                    if (markStale) staleRef.current.add(identity);

                    if (!stillOnThisFlow()) return;

                    // Superseded: the refusal describes a list that no longer exists, and
                    // the save of the newer one is already queued. Let that one speak.
                    if (!showError && !revertToStored) return;

                    error(cause instanceof ApiError ? cause.message : 'Could not save resources.');

                    // Forget what was sent, so the next edit is sent even if it happens
                    // to produce the same list the server just refused. Read by the effect
                    // as "send regardless", which is why the load test above is keyed on
                    // the flow rather than on this being set.
                    savedRef.current = undefined;

                    // A stale version keeps the list on screen: the operator's typing is not
                    // what is wrong, and the message tells them to reload. See
                    // `describeSaveFailure`.
                    if (!revertToStored) return;

                    void loadResources(guildId, endpoint()).then((stored) => {
                        if (!stillOnThisFlow()) return;
                        // A newer save of this list may have answered first; its version is
                        // the later one, and a read that left before it must not undo it.
                        if (!shouldAcceptResponse(issued, issuedRef.current)) return;
                        versionsRef.current.set(identity, stored.updatedAt);
                        savedRef.current = JSON.stringify(stored.resources);
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
        // The endpoint is looked up per identity (`targetsRef`), so the identity names it.
        [guildId, identity]
    );

    useEffect(() => {
        // Whether there is a target, not the object: this effect's cleanup clears the debounce
        // timer, so a dependency that changed every render would reset it every render.
        if (!loaded || !guildId || !hasTarget) return;

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
            // not seen, so it is recorded rather than sent back — with the version it was
            // read at, which the first save of it sends.
            baselineFlowRef.current = identity;
            savedRef.current = serialised;
            versionsRef.current.set(identity, latestVersionRef.current);
            // Loaded afresh, at the journey's version now: as good as the reload it asked for.
            staleRef.current.delete(identity);
            return;
        }

        // The journey moved on under this list. Every save would be refused again, so none is
        // sent; the message to reload is already up, and stays up.
        if (staleRef.current.has(identity)) return;

        // Mid-edit invalidity is normal and the chips already report it in place. Holding
        // means the save happens as soon as the row is sendable again, without a server
        // banner describing something half-typed.
        if (!isWorthSaving(resources)) return;

        const handle = window.setTimeout(() => send(resources), RESOURCE_SAVE_DEBOUNCE_MS);
        return () => window.clearTimeout(handle);
    }, [resources, loaded, guildId, identity, hasTarget, send]);

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
            // A baseline belonging to another flow — or to the journey this one was
            // attached to before — means nothing here was edited.
            if (baselineFlowRef.current !== watching) return;

            /**
             * Leaving a list whose journey moved on under it. Its last save was refused, so
             * what is on screen was never stored, and sending it again would only be refused
             * the same way. A toast, for the reason the unsaveable case below gives: the
             * panel's message unmounts with the page.
             */
            if (staleRef.current.has(watching)) {
                notifications.show({
                    color: 'orange',
                    title: 'Some resources were not saved',
                    message:
                        'Somebody else saved these resources after you loaded them, so your last changes went nowhere. Reload, then make them again.',
                });
                return;
            }

            if (savedRef.current === undefined) return;
            if (JSON.stringify(pending) === savedRef.current) return;

            /**
             * Leaving with a row the server would refuse.
             *
             * The whole list is unsendable, not just the offending row — a partial list
             * is a *deletion* of everything omitted, so sending the valid subset would be
             * worse than sending nothing. The debounced save has been holding, correctly,
             * and now there is no later keystroke to release it.
             *
             * Warned rather than swallowed. It is reachable only by clearing a name or key,
             * leaving a "Specific roles" rule with no role picked, or leaving a message the
             * save would refuse, and then navigating away — rows are seeded valid — but silent
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
                        'A resource was left without a name or key, with a permission rule naming no role, or with a message the save would refuse, so the list could not be stored. Reopen it to finish the job.',
                });
                return;
            }

            send(pending);
        };
    }, [send, guildId, identity]);
}
