/**
 * When leaving the flow builder has to ask first.
 *
 * Pure, and split from `useLeaveGuard` so the rule can be read and tested without a router.
 *
 * **Unsaved means "not the saved flow"**, even when the autosave has already put the canvas
 * in the operator's draft. A draft is insurance, not a decision: the operator who walks out
 * mid-edit is asked what they meant, and "Keep as draft" is one answer rather than the
 * silent default. A draft-only *save* is different — the operator pressed Save, and the
 * page stops counting the canvas as unsaved — so it does not ask.
 */

export interface LeaveAttempt {
    /** The canvas differs from the saved flow. */
    readonly unsaved: boolean;
    /** Where the builder is now. */
    readonly fromPath: string;
    /** Where the navigation is headed. */
    readonly toPath: string;
}

/**
 * Whether a navigation must wait for the operator's answer.
 *
 * Only a change of page. A navigation that stays on the builder's own path — its
 * `?install=1` hand-off stripping itself from the URL, say — drops nothing, and holding it
 * would put a leave prompt in front of an operator who is not leaving.
 */
export function shouldConfirmLeave({ unsaved, fromPath, toPath }: LeaveAttempt): boolean {
    return unsaved && fromPath !== toPath;
}
