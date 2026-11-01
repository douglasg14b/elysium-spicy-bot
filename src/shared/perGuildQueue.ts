/** Runs `work` after every task already queued for `guildId` has finished. */
export type PerGuildQueue = <Result>(guildId: string, work: () => Promise<Result>) => Promise<Result>;

/**
 * A queue that runs each guild's tasks one at a time, in the order they were queued, and
 * different guilds' side by side.
 *
 * One per purpose: two purposes sharing a queue would make each wait on the other's work
 * for no reason. A task runs after the one before it has finished, whether that succeeded
 * or not, and a guild's entry goes once the last task in it has finished.
 *
 * In this process, which is the only one: the bot runs as a single process (as the
 * dashboard's rate limit also relies on).
 */
export function createPerGuildQueue(): PerGuildQueue {
    const inProgress = new Map<string, Promise<void>>();

    return async <Result>(guildId: string, work: () => Promise<Result>): Promise<Result> => {
        const previous = inProgress.get(guildId) ?? Promise.resolve();
        const run = previous.then(work);
        const finished = run.then(
            () => undefined,
            () => undefined
        );
        inProgress.set(guildId, finished);
        try {
            return await run;
        } finally {
            if (inProgress.get(guildId) === finished) inProgress.delete(guildId);
        }
    };
}
