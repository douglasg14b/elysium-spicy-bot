import { database, type DatabaseClient } from '../../data-persistence/database';

/**
 * A session whose preceding gap has not been backfilled yet, with what that gap is
 * measured from.
 */
export type UnfilledRecorderSession = {
    readonly id: number;
    readonly startedAt: Date;
    /**
     * The previous session's last heartbeat: when recording last provably happened before
     * this session began. Null only when no earlier session exists, which leaves nothing
     * to measure a gap from.
     */
    readonly previousLastSeenAt: Date | null;
};

/** Persistence for `activity_recorder_sessions`. SQL lives here and nowhere else. */
export class ActivityRecorderSessionsRepo {
    constructor(private readonly db: DatabaseClient = database) {}

    /**
     * Record that this process began recording, and return the new session's id.
     *
     * The very first session is marked filled as it is inserted: there is no earlier
     * session to measure a gap from, and no baseline is guessed. A check and an insert
     * rather than one transaction, because only one process opens a session, at startup.
     */
    async open(startedAt: Date): Promise<number> {
        const earlier = await this.db.selectFrom('activity_recorder_sessions').select('id').limit(1).executeTakeFirst();
        const at = startedAt.toISOString();

        const row = await this.db
            .insertInto('activity_recorder_sessions')
            .values({ startedAt: at, lastSeenAt: at, gapFilledAt: earlier ? null : at })
            .returning('id')
            .executeTakeFirstOrThrow();

        return row.id;
    }

    /** Refresh a live session's `lastSeenAt`. */
    async heartbeat(id: number, at: Date): Promise<void> {
        await this.db
            .updateTable('activity_recorder_sessions')
            .set({ lastSeenAt: at.toISOString() })
            .where('id', '=', id)
            .execute();
    }

    /**
     * Every session whose preceding gap is still unfilled, oldest first, each with its
     * predecessor's last heartbeat.
     *
     * One lookup per unfilled session for the predecessor. There is normally exactly one
     * unfilled session (this process's), and two after a crash mid-backfill.
     */
    async findUnfilled(): Promise<UnfilledRecorderSession[]> {
        const unfilled = await this.db
            .selectFrom('activity_recorder_sessions')
            .select(['id', 'startedAt'])
            .where('gapFilledAt', 'is', null)
            .orderBy('id', 'asc')
            .execute();

        const sessions: UnfilledRecorderSession[] = [];
        for (const session of unfilled) {
            const previous = await this.db
                .selectFrom('activity_recorder_sessions')
                .select('lastSeenAt')
                .where('id', '<', session.id)
                .orderBy('id', 'desc')
                .limit(1)
                .executeTakeFirst();

            sessions.push({
                id: session.id,
                startedAt: session.startedAt,
                previousLastSeenAt: previous?.lastSeenAt ?? null,
            });
        }
        return sessions;
    }

    /** Record that the gap before this session has been backfilled. */
    async markGapFilled(id: number, at: Date): Promise<void> {
        await this.db
            .updateTable('activity_recorder_sessions')
            .set({ gapFilledAt: at.toISOString() })
            .where('id', '=', id)
            .execute();
    }
}

export const activityRecorderSessionsRepo = new ActivityRecorderSessionsRepo();
