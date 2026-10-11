import type { FlowRunEntity, FlowRunWaitConfig } from '../data/flowRunsSchema';

/**
 * One run parked on a message wait, as the live wake and the outage catch-up read it.
 *
 * Immutable: every write replaces the run's entry with a new object, so a caller
 * holding one can tell — by identity — whether the run has parked again since.
 */
export interface MessageWaitEntry {
    readonly runId: string;
    readonly guildId: string;
    /** The run's member, the only one whose message can wake it. */
    readonly userId: string;
    /** The channel listened in, threads under it included. Absent means anywhere. */
    readonly channelId?: string;
    readonly parkedAt: Date;
    /** The park's time limit, when it has one. */
    readonly wakeAt: Date | null;
}

/**
 * A park as each transition knows it, whatever it is waiting on. Only a message wait
 * becomes an entry; anything else removes the run's entry.
 */
export interface MessageWaitPark {
    readonly runId: string;
    readonly guildId: string;
    /**
     * The run's member, absent on a run about nobody. Every park is recorded — a Delay as
     * much as a message wait — so absence is ordinary here; only a *message* wait without
     * a member is refused, since nobody's message could ever wake it.
     */
    readonly userId?: string;
    readonly waitConfig: FlowRunWaitConfig | null | undefined;
    readonly wakeAt: Date | null | undefined;
}

/** Who posted a message and where, as the index matches it. */
export interface MessageContext {
    readonly guildId: string;
    readonly userId: string;
    readonly channelId: string;
    /** The channel a thread sits under, when posted in a thread. */
    readonly parentChannelId: string | null;
}

/**
 * Every run parked on a message wait in this process, in memory, so a message nobody
 * is waiting on costs a map lookup and no database read.
 *
 * Keyed by run, one entry each, with a second map from guild and member to run ids for
 * matching. **Every transition writes or removes the run's entry, whatever it is now
 * waiting on** — the executor's first park, a re-park, a released claim (from the park
 * it gave back) and a successful claim (which removes it). The scheduler loads it from
 * the database once at startup, after it has reclaimed runs a dead process left claimed.
 * An entry is never removed because a claim missed: a miss can land after the winning
 * wake has already parked the run again, and removing then would lose that fresh park.
 *
 * So the index is only ever stale in one direction — an entry for a run that has moved
 * on — which every message wake guards against twice: it skips a run whose entry is no
 * longer the one it matched, and its claim is narrowed to `waitKind = 'message'`.
 *
 * A run is in the index only while parked. A message that arrives while it is mid-resume
 * — claimed, not yet parked again — wakes nothing: the run is not waiting at that
 * instant, and the member's next message or its time limit moves it on.
 */
export class MessageWaitIndex {
    private readonly byRun = new Map<string, MessageWaitEntry>();
    private readonly byMember = new Map<string, Set<string>>();

    /**
     * Write the run's entry from its park, or remove it when the park is not a message wait.
     *
     * Throws for a message wait on a run about nobody. Save-time validation refuses a
     * wait there (Wait for Event requires a member), so reaching it means that check
     * regressed — and an entry keyed by nobody would sit in the index forever, matching no
     * message. The run's old entry is removed first either way, so the throw never leaves
     * a stale one behind.
     */
    record(park: MessageWaitPark): void {
        this.delete(park.runId);

        const config = park.waitConfig;
        if (config?.eventKind !== 'message') {
            return;
        }

        checkMessageWaitHasMember(park);
        const { userId } = park;
        // Unreachable — the check above has thrown — but it narrows the type honestly.
        if (!userId) {
            return;
        }

        const entry: MessageWaitEntry = {
            runId: park.runId,
            guildId: park.guildId,
            userId,
            ...(config.channelId ? { channelId: config.channelId } : {}),
            parkedAt: new Date(config.parkedAt),
            wakeAt: park.wakeAt ?? null,
        };
        this.byRun.set(entry.runId, entry);

        const key = memberKey(entry.guildId, entry.userId);
        const runIds = this.byMember.get(key) ?? new Set<string>();
        runIds.add(entry.runId);
        this.byMember.set(key, runIds);
    }

    /** Remove the run's entry, if it has one. */
    delete(runId: string): void {
        const entry = this.byRun.get(runId);
        if (!entry) return;

        this.byRun.delete(runId);
        const key = memberKey(entry.guildId, entry.userId);
        const runIds = this.byMember.get(key);
        runIds?.delete(runId);
        if (runIds?.size === 0) {
            this.byMember.delete(key);
        }
    }

    /** The run's current entry, if it is parked on a message wait. */
    get(runId: string): MessageWaitEntry | undefined {
        return this.byRun.get(runId);
    }

    /**
     * The entries this message satisfies: the poster's own runs, listening anywhere, in
     * the channel posted in, or in the channel a thread sits under.
     *
     * A **copy**, taken before any is resumed, so a run that parks again while the caller
     * works through the list is not handed back a second time for the same message.
     */
    matching(message: MessageContext): MessageWaitEntry[] {
        const runIds = this.byMember.get(memberKey(message.guildId, message.userId));
        if (!runIds) return [];

        return [...runIds]
            .map((runId) => this.byRun.get(runId))
            .filter((entry): entry is MessageWaitEntry => {
                if (!entry) return false;
                const { channelId } = entry;
                return !channelId || channelId === message.channelId || channelId === message.parentChannelId;
            });
    }

    /** Every indexed run id, copied. */
    runIds(): string[] {
        return [...this.byRun.keys()];
    }

    /**
     * Add these runs' parks, keeping any entry the index already holds.
     *
     * Additive, not a replace, because the runs were read a moment earlier and a run may
     * have parked or moved on since: the entry its own transition wrote is newer than
     * the row read before it. A row for a run that has since been claimed adds a stale
     * entry, which every message wake already tolerates.
     *
     * Each run is added on its own: one row the index refuses — a message wait with no
     * member — is logged by run id and skipped, and every other run still loads. Letting
     * it throw would leave the whole index empty, so no run would wake on a message.
     */
    addMissing(runs: readonly FlowRunEntity[]): void {
        for (const run of runs) {
            if (this.byRun.has(run.runId)) {
                continue;
            }
            try {
                this.record(parkOf(run));
            } catch (error) {
                console.error(`[flow-runs] Could not index run ${run.runId} as waiting on a message:`, error);
            }
        }
    }
}

/**
 * Throw for a message wait on a run about nobody — nobody's message could ever wake it.
 *
 * Save-time validation refuses a wait on such a path (Wait for Event requires a member),
 * so this only fires if that check regressed. The executor and the resume path call it
 * **before** writing the park, so the invariant fails with nothing written; the index
 * calls it too, as the last line of defence for a row already stored.
 */
export function checkMessageWaitHasMember(park: Pick<MessageWaitPark, 'runId' | 'userId' | 'waitConfig'>): void {
    if (park.waitConfig?.eventKind === 'message' && !park.userId) {
        throw new Error(
            `Run ${park.runId} parked on a message wait but is about nobody, so no message could ever ` +
                'wake it. Save-time validation should have refused a wait on this path.'
        );
    }
}

/** A stored run's park, as {@link MessageWaitIndex.record} reads it. */
export function parkOf(run: FlowRunEntity): MessageWaitPark {
    return {
        runId: run.runId,
        guildId: run.guildId,
        userId: run.contextSnapshot.userId,
        waitConfig: run.waitConfig,
        wakeAt: run.wakeAt,
    };
}

function memberKey(guildId: string, userId: string): string {
    // Snowflakes are digits, so the separator cannot occur inside either half.
    return `${guildId}/${userId}`;
}

/** The process's one index. */
export const messageWaitIndex = new MessageWaitIndex();
