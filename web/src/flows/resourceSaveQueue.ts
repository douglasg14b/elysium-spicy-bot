/**
 * Deciding what a stream of resource edits should send, and what it may accept back.
 *
 * Split out of `FlowBuilderPage` because the bug it fixes was a *sequencing* bug, and
 * sequencing is the one thing a component cannot be asked about: `web/` has no jsdom, so
 * the original defect — every keystroke disabling its own input and then reverting
 * itself — was unreachable by the suite and shipped green.
 *
 * ## The bug
 *
 * The panel's `onChange` was wired straight to the save endpoint. Each keystroke
 * therefore:
 *
 *  1. set a `saving` flag, which the panel spread onto every input as `disabled` — and by
 *     HTML's **focus fixup rule**, an element that stops being focusable while focused
 *     hands the focus back to the document. The browser takes the cursor; React cannot
 *     decline on its behalf;
 *  2. sent a PUT carrying a half-typed declaration, which the server's `resourceSchema`
 *     rightly refused (`key` must match the slug pattern, `defaultName` must be
 *     non-empty — `my-chann` on the way to `my-channel` is fine, but `''` is not);
 *  3. on that refusal re-read the server's list and wrote it over local state, throwing
 *     away every character typed since.
 *
 * So the field lost focus, and what had been typed into it was reverted. Three separate
 * mechanisms, one cause: **the edit and the persistence of the edit were the same
 * event.**
 *
 * ## The rule this module encodes
 *
 * An edit is local and immediate. A save is a *consequence* of edits having stopped, and
 * it may never contradict something newer than itself.
 *
 * That second half is the part worth testing. Three orderings have to hold:
 *
 *  - a response that arrives after further edits is **ignored**, not applied;
 *  - a *failure* likewise must not re-read the server over a list still being edited —
 *    the re-read is correct only when the local list is the one that was refused;
 *  - a save that is superseded while in flight is followed by one carrying the newer
 *    list, or the last edits are never persisted at all.
 *
 * `shouldAcceptResponse` and `describeSaveFailure` are those decisions, taken over a
 * monotonic request number rather than over the lists themselves. Comparing lists by
 * value was the rejected alternative: two edits can produce an equal list (type a
 * character, delete it) and a value comparison would call the second one stale.
 */

import type { ResourceDeclaration } from '../api/types';

/**
 * How long editing must pause before the declaration list is written to the server.
 *
 * 600ms. Long enough that ordinary typing — including the pause mid-word that thinking
 * about a name produces — coalesces into one save, short enough that the list is durable
 * before an operator's hand leaves the keyboard for the mouse.
 *
 * It is not a guess at "feels responsive": nothing waits on this. The panel has already
 * shown the edit, and the pickers elsewhere in the builder read `declaredResources` from
 * local state, so the only thing the delay postpones is durability. The modal's close
 * and the page's unmount both flush, so the window in which a save can be lost is a
 * crash, not a navigation.
 */
export const RESOURCE_SAVE_DEBOUNCE_MS = 600;

/**
 * Whether a save's response still describes the list the operator is looking at.
 *
 * **Why a counter and not a comparison.** The response carries the server's normalised
 * copy of what was sent, which is genuinely worth adopting — it is the canonical shape,
 * and ignoring it would let the browser drift from what was stored. But adopting a
 * response that a later edit has already superseded is precisely the revert this module
 * exists to stop. The request number says which of the two happened without having to
 * guess from the contents.
 *
 * `issued` is the number the request was given when it left; `latest` is the newest
 * number issued since. Equal means nothing has happened in between and the response is
 * current.
 */
export function shouldAcceptResponse(issued: number, latest: number): boolean {
    return issued === latest;
}

/**
 * What a rejected save should do to the panel.
 *
 * Two different situations wear the same HTTP failure, and conflating them is what made
 * the original bug destructive:
 *
 *  - **the list that was refused is still the list on screen.** The operator should see
 *    why, and re-reading the server is safe because there is nothing local to lose.
 *  - **editing continued while the request was in flight.** The refusal describes a list
 *    that no longer exists. Re-reading would overwrite work in progress with an older
 *    server copy — the revert. Showing the message would also be a lie, since it may
 *    already have been fixed by the very keystrokes that superseded it.
 *
 * The second case is not an error to suppress quietly: the newer list is about to be
 * saved by the follow-up save, and *that* response is the one that gets to speak. If it
 * is also refused, the operator sees the message then, describing what they currently
 * have.
 */
export interface SaveFailureResponse {
    /** Show the server's message on the panel. */
    readonly showError: boolean;
    /** Re-read the stored list, discarding what is on screen. */
    readonly revertToStored: boolean;
}

export function describeSaveFailure(issued: number, latest: number): SaveFailureResponse {
    const current = shouldAcceptResponse(issued, latest);
    return { showError: current, revertToStored: current };
}

/**
 * What the autosave effect should do with the list it has just been handed.
 *
 * Extracted because the three-way choice below was originally a pair of `if`s over two
 * refs, and one of those refs was carrying two meanings at once — which produced a bug
 * where the first edit after a *rejected* save was silently swallowed: the failure path
 * cleared the "last confirmed list" marker to force a resend, and the load path read that
 * same cleared marker as "first sight of this flow, record and send nothing".
 *
 * Splitting the question out makes the three cases nameable and testable:
 *
 *  - `adoptBaseline` — this is the flow's stored list arriving, not an edit of it. Record
 *    it and send nothing. Keyed on **which flow, and which journey**, so that neither
 *    navigating between flows nor attaching a flow to a different journey can mistake
 *    one stored list for an edit of another.
 *  - `send` — it differs from what the server last confirmed, or a previous save was
 *    refused and the next edit must go regardless of whether it looks identical.
 *  - `wait` — nothing to do.
 */
export type AutosaveAction = 'adoptBaseline' | 'send' | 'wait';

export interface AutosaveDecisionInput {
    /**
     * What the list in hand describes: `guildId/flowId/journeyKey`.
     *
     * **The journey is part of the identity, not decoration.** A flow's declarations
     * belong to the journey it is attached to, and attaching moves it to a different one
     * without the flow id changing. Without the journey here, the newly loaded list
     * differs from the previous journey's confirmed one, so the effect reads it as an
     * *edit* and sends it — writing one journey's declarations into another, which on a
     * shared journey is refused with a 409 the operator meets immediately after a
     * successful attach, and on an unshared one is a silent write they never asked for.
     */
    readonly identity: string;
    /** Which flow `confirmed` describes, or `undefined` before anything has loaded. */
    readonly baselineIdentity: string | undefined;
    /** The serialised list the server last confirmed; `undefined` after a refusal. */
    readonly confirmed: string | undefined;
    /** The serialised list in hand. */
    readonly current: string;
}

export function decideAutosaveAction({
    identity,
    baselineIdentity,
    confirmed,
    current,
}: AutosaveDecisionInput): AutosaveAction {
    if (baselineIdentity !== identity) return 'adoptBaseline';
    // A cleared `confirmed` means the last save was refused. Sending is required even
    // when the list looks unchanged, or the refusal would strand every later edit.
    if (confirmed === undefined) return 'send';
    return current === confirmed ? 'wait' : 'send';
}

/**
 * Whether a list is worth sending at all.
 *
 * A mid-edit declaration is *routinely* invalid — an empty key while retyping one, an
 * empty name the instant a row is added — and those states are already reported by the
 * chips, in place, next to the field. Sending them produces a red server banner
 * describing something the operator is in the middle of doing and has not finished.
 *
 * So the queue holds rather than sends, and the chips carry the explanation until the
 * list is sendable again. This is deliberately a **weaker** check than the server's: it
 * is not trying to validate, only to avoid nagging. Anything it lets through and the
 * server refuses is a genuine disagreement worth showing, which is why `duplicateKey`
 * and dangling references are *not* checked here — those persist past the keystroke that
 * caused them, and silently declining to save them would leave the operator with no
 * feedback at all about why nothing was stored.
 */
export function isWorthSaving(resources: readonly ResourceDeclaration[]): boolean {
    return resources.every((resource) => Boolean(resource.key) && Boolean(resource.defaultName));
}
