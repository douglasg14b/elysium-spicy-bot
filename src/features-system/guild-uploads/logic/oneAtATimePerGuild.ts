/**
 * Each guild's upload write in progress — a store or a delete — so a guild's writes run one
 * at a time, and an upload and a delete of the same picture cannot interleave.
 */
const writesInProgress = new Map<string, Promise<void>>();

/**
 * Runs `work` after every write already queued for `guildId` has finished, whether it
 * succeeded or not. The queue entry goes once the last write in it has finished.
 *
 * In this process, which is the only one: the bot runs as a single process (as the
 * dashboard's rate limit also relies on).
 */
export async function oneAtATimePerGuild<Result>(guildId: string, work: () => Promise<Result>): Promise<Result> {
    const previous = writesInProgress.get(guildId) ?? Promise.resolve();
    const run = previous.then(work);
    const finished = run.then(
        () => undefined,
        () => undefined
    );
    writesInProgress.set(guildId, finished);
    try {
        return await run;
    } finally {
        if (writesInProgress.get(guildId) === finished) writesInProgress.delete(guildId);
    }
}
