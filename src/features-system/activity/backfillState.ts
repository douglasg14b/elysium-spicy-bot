/**
 * Whether activity is still recovering messages it missed while the bot was down.
 *
 * In memory on purpose: it describes this process, and a restart starts a fresh
 * backfill that sets it again. True from wiring until every unfilled gap has been
 * attempted, or until finding the gaps failed — see `startRecorderSession`.
 *
 * Read by whatever must not act on incomplete history: the flow scheduler holds runs
 * with a quiet window while it is true, because their deadline depends on messages the
 * backfill has not restored yet.
 */
let backfillPending = false;

/** True while a startup backfill has not finished; quiet-window decisions must wait. */
export function isBackfillPending(): boolean {
    return backfillPending;
}

/** Hold quiet-window decisions until {@link clearBackfillPending}. */
export function markBackfillPending(): void {
    backfillPending = true;
}

/** Release the hold: the backfill finished, failed, or could not start. */
export function clearBackfillPending(): void {
    backfillPending = false;
}
