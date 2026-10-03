/**
 * Whether activity is still recovering messages it missed while the bot was down.
 *
 * In memory on purpose: it describes this process, and a restart starts a fresh
 * backfill that sets it again. True from wiring until every unfilled gap has been
 * attempted, or until finding the gaps failed — see `startRecorderSession`.
 *
 * Read by whatever must not act on incomplete history: the flow scheduler holds runs
 * with a quiet window while it is true, because their deadline depends on messages the
 * backfill has not restored yet, and holds message waits until it has looked for the
 * replies the backfill restored.
 */
let backfillPending = false;

/** Callbacks waiting for the backfill to finish; each is called once, then dropped. */
const finishedCallbacks: (() => void)[] = [];

/** True while a startup backfill has not finished; quiet-window decisions must wait. */
export function isBackfillPending(): boolean {
    return backfillPending;
}

/** Hold quiet-window decisions until {@link clearBackfillPending}. */
export function markBackfillPending(): void {
    backfillPending = true;
}

/**
 * Release the hold: the backfill finished, failed, or could not start. Calls every
 * callback {@link whenBackfillFinished} was waiting with.
 */
export function clearBackfillPending(): void {
    backfillPending = false;

    for (const callback of finishedCallbacks.splice(0)) {
        try {
            callback();
        } catch (error) {
            console.error('[activity] A backfill-finished callback failed:', error);
        }
    }
}

/**
 * Call `callback` once the startup backfill is over — straight away when it already is.
 *
 * "Over" includes a backfill that **failed or never started**: `startRecorderSession`
 * clears the flag however it ended, so a caller acting on the history then is acting on
 * partial history — whatever the live recorder heard, without the outage. That is the
 * same history the scheduler decides quiet windows on in that case; a caller that needs
 * more has no better source to wait for.
 *
 * Fires immediately for a caller registering after it is over, so wiring order between
 * activity and its consumers cannot leave one waiting forever. Each registration fires
 * once: a later re-mark (the recorder session raises the flag again as it starts) does
 * not call it a second time.
 */
export function whenBackfillFinished(callback: () => void): void {
    if (!backfillPending) {
        callback();
        return;
    }
    finishedCallbacks.push(callback);
}
