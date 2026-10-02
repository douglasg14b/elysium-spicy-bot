import type { Client } from 'discord.js';
import { backfillUnfilledGaps, type ActivityBackfillDependencies } from './activityBackfill';
import { clearBackfillPending, markBackfillPending } from './backfillState';
import { RECORDER_HEARTBEAT_INTERVAL_MS } from './backfillGaps';
import {
    activityRecorderSessionsRepo,
    type ActivityRecorderSessionsRepo,
    type UnfilledRecorderSession,
} from './data/activityRecorderSessionsRepo';
import { activityEventsRepo } from './data/activityEventsRepo';

export type RecorderSessionDependencies = ActivityBackfillDependencies & {
    readonly sessionsRepo: Pick<ActivityRecorderSessionsRepo, 'open' | 'heartbeat' | 'findUnfilled' | 'markGapFilled'>;
};

const defaultDependencies: RecorderSessionDependencies = {
    activityEventsRepo,
    sessionsRepo: activityRecorderSessionsRepo,
};

let heartbeat: ReturnType<typeof setInterval> | null = null;

/**
 * Begin this process's recorder session, then backfill what was missed before it.
 *
 * Runs once the client is ready, and nothing awaits it: live recording is already on,
 * and only runs with a quiet window wait for the backfill, through `isBackfillPending`.
 * In order:
 *
 *  1. insert the session and start its heartbeat;
 *  2. find every gap not yet filled — this one, and any a crash left behind;
 *  3. backfill them, oldest first;
 *  4. clear the pending flag, however that went.
 *
 * Failing to open the session or to find the gaps clears the flag and says so loudly.
 * Quiet runs are then decided on the history there is, exactly as before backfill
 * existed, rather than held for a backfill that will never come.
 */
export async function startRecorderSession(
    client: Client<true>,
    dependencies: RecorderSessionDependencies = defaultDependencies
): Promise<void> {
    // `initActivityTracking` already raised it at wiring, which is the one the scheduler's
    // ordering depends on. Raised again so a caller that skips wiring holds runs too.
    markBackfillPending();
    try {
        let sessionId: number;
        try {
            sessionId = await dependencies.sessionsRepo.open(new Date());
        } catch (error) {
            console.error(
                '[activity] Could not open a recorder session. Messages missed while the bot was down will not be ' +
                    'backfilled, so quiet-window runs will be decided without them:',
                error
            );
            return;
        }

        startHeartbeat(sessionId, dependencies);

        let sessions: UnfilledRecorderSession[];
        try {
            sessions = await dependencies.sessionsRepo.findUnfilled();
        } catch (error) {
            console.error(
                '[activity] Could not find the gaps to backfill. Messages missed while the bot was down will not be ' +
                    'recovered this run, so quiet-window runs will be decided without them:',
                error
            );
            return;
        }

        try {
            await backfillUnfilledGaps(client, sessions, new Date(), dependencies);
        } catch (error) {
            console.error(
                '[activity] Backfill stopped before it finished; the unfinished gap is retried on the next start:',
                error
            );
        }
    } finally {
        clearBackfillPending();
    }
}

/**
 * Refresh the session's `lastSeenAt` every minute, which is what the next start measures
 * its gap from. Unref'd, so it never holds the process open. A failed beat is logged and
 * the next one tried: a stale `lastSeenAt` only widens the next gap, which is harmless.
 */
function startHeartbeat(sessionId: number, dependencies: RecorderSessionDependencies): void {
    stopRecorderHeartbeat();
    heartbeat = setInterval(() => {
        void dependencies.sessionsRepo.heartbeat(sessionId, new Date()).catch((error: unknown) => {
            console.error(`[activity] Recorder session ${sessionId} heartbeat failed:`, error);
        });
    }, RECORDER_HEARTBEAT_INTERVAL_MS);
    heartbeat.unref();
}

/**
 * Clear the heartbeat interval. Test seam: production never stops it, since it is
 * unref'd and a missing last beat only widens the next gap by the margin it already has.
 */
export function stopRecorderHeartbeat(): void {
    if (heartbeat) {
        clearInterval(heartbeat);
        heartbeat = null;
    }
}
