/**
 * One guild-changing operation per journey at a time.
 *
 * Install, drift repair and uninstall each build a plan and then act on it. Two of them
 * running at once on one journey each act on a plan the other is busy invalidating: two
 * installs both plan a `create` for the same key, both create, and only one can settle
 * the binding — the other leaves a duplicate channel in the server and can only say so
 * afterwards. The binding table's guards stop the *record* going wrong; this stops the
 * *guild* going wrong, which no guard after the fact can undo.
 *
 * Taken where each operation enters provisioning: `runInstall` (around the plan rebuild
 * too, which is why install alone takes it above the apply), `repairDrift` and
 * `unpublishJourney`. None is taken inside another, so a key is never acquired twice.
 *
 * **Refuses rather than queues.** A queued operation would run a plan the operator
 * approved before the first one changed the server, which is the stale-approval case
 * every route here already rebuilds its plan to avoid.
 *
 * **In-process, and that is a limit, not an oversight.** The bot is one process, so a
 * map is the whole truth. Pointing a second instance at the same database makes this
 * wrong, and it is then the first thing to replace — the same boundary
 * `reclaimAbandonedClaims` states for itself.
 */

export type JourneyOperation = 'install' | 'repair' | 'uninstall';

export type JourneyLockOutcome<T> =
    | { readonly status: 'ran'; readonly value: T }
    | { readonly status: 'busy'; readonly running: JourneyOperation };

const running = new Map<string, JourneyOperation>();

/**
 * Run `work` holding this journey's lock, or report what already holds it.
 *
 * The check and the claim happen with no `await` between them, so two requests arriving
 * together cannot both see the journey free.
 */
export async function withJourneyLock<T>(
    guildId: string,
    journeyKey: string,
    operation: JourneyOperation,
    work: () => Promise<T>
): Promise<JourneyLockOutcome<T>> {
    // A guild id is all digits, so the separator cannot be forged by a journey key.
    const key = `${guildId}:${journeyKey}`;
    const holder = running.get(key);
    if (holder) {
        return { status: 'busy', running: holder };
    }

    running.set(key, operation);
    try {
        return { status: 'ran', value: await work() };
    } finally {
        running.delete(key);
    }
}

const RUNNING_NOUN: Record<JourneyOperation, string> = {
    install: 'An install',
    repair: 'A repair',
    uninstall: 'An uninstall',
};

/** What a refused operation tells the operator. Nothing was touched, and it says so. */
export function journeyBusyMessage(holder: JourneyOperation): string {
    return `${RUNNING_NOUN[holder]} of this journey is still running, so nothing was changed. Wait for it to finish, then try again.`;
}
