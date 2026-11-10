import type { TraceLookup, TracedTurn, TurnTrace } from './historyToModelMessages';

/** A channel nobody has spoken to the bot in for this long is forgotten. */
export const SESSION_IDLE_TTL_MS = 30 * 60_000;

/** Only the latest few replies keep their tool trace; older ones fall back to their text. */
export const MAX_TRACED_TURNS_PER_CHANNEL = 5;

/** Bounds memory if the bot is busy in very many channels at once. */
const MAX_SESSIONS = 500;

type ChannelSession = {
    /** First message id of each traced reply, oldest first, so the oldest can be dropped. */
    readonly turnOrder: string[];
    readonly traces: Map<string, TurnTrace>;
    lastActiveAt: number;
};

/**
 * The agent's memory of each channel: the tool trace behind each of its recent replies,
 * keyed by the Discord message ids those replies were posted as, with who each answered —
 * a trace is replayed only to the same asker (`historyToModelMessages`).
 *
 * In memory on purpose. Everything people said is in Discord and is re-read each turn;
 * this only spares the agent re-looking-up what it just looked up. A restart costs that
 * and nothing else.
 */
export class ChatSessionStore {
    private readonly sessions = new Map<string, ChannelSession>();

    /** Looks up traces in `channelId`'s session, refreshing its idle clock. */
    traceLookup(channelId: string, now: number = Date.now()): TraceLookup {
        this.evictIdle(now);
        const session = this.sessions.get(channelId);
        if (session) session.lastActiveAt = now;
        return (messageId) => session?.traces.get(messageId);
    }

    /**
     * Remembers the turn behind a reply posted as `postedMessageIds` (one per part, in
     * order, only those that actually posted), so a failed send leaves nothing behind that
     * names a message that does not exist.
     */
    recordTurn(channelId: string, postedMessageIds: readonly string[], turn: TracedTurn, now: number = Date.now()): void {
        const [firstId, ...continuationIds] = postedMessageIds;
        if (!firstId) return;

        const session = this.sessionFor(channelId, now);
        session.traces.set(firstId, turn);
        for (const id of continuationIds) session.traces.set(id, 'continuation');
        session.turnOrder.push(firstId);
        session.lastActiveAt = now;

        while (session.turnOrder.length > MAX_TRACED_TURNS_PER_CHANNEL) {
            const dropped = session.turnOrder.shift();
            if (dropped) this.forgetTurn(session, dropped);
        }
    }

    private sessionFor(channelId: string, now: number): ChannelSession {
        const existing = this.sessions.get(channelId);
        if (existing) return existing;

        this.evictIdle(now);
        if (this.sessions.size >= MAX_SESSIONS) this.evictLeastRecent();
        const created: ChannelSession = { turnOrder: [], traces: new Map(), lastActiveAt: now };
        this.sessions.set(channelId, created);
        return created;
    }

    /**
     * Drops a reply's trace and its continuations. A continuation always directly follows
     * its first part in `traces`' insertion order, so they are the entries after it up to
     * the next non-continuation.
     */
    private forgetTurn(session: ChannelSession, firstId: string): void {
        let removing = false;
        for (const [id, trace] of session.traces) {
            if (id === firstId) removing = true;
            else if (removing && trace !== 'continuation') break;
            if (removing) session.traces.delete(id);
        }
    }

    private evictIdle(now: number): void {
        for (const [channelId, session] of this.sessions) {
            if (now - session.lastActiveAt > SESSION_IDLE_TTL_MS) this.sessions.delete(channelId);
        }
    }

    private evictLeastRecent(): void {
        let oldestId: string | undefined;
        let oldestAt = Infinity;
        for (const [channelId, session] of this.sessions) {
            if (session.lastActiveAt < oldestAt) {
                oldestAt = session.lastActiveAt;
                oldestId = channelId;
            }
        }
        if (oldestId) this.sessions.delete(oldestId);
    }
}
