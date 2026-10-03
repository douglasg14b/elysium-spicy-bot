import {
    FLOW_MESSAGE_LIMIT_PER_GUILD,
    FLOW_MESSAGE_LIMIT_PER_GUILD_INTERVAL_MS,
    FLOW_MESSAGE_LIMIT_PER_MEMBER,
    FLOW_MESSAGE_LIMIT_PER_MEMBER_INTERVAL_MS,
    FLOW_MESSAGE_LIMIT_SUMMARY_INTERVAL_MS,
} from '../constants';

/** How many tokens a key may hold, and how fast a spent one comes back. */
export interface TokenLimitOptions {
    /** Most tokens one key holds — how much it may spend at once. */
    readonly limit: number;
    /** Milliseconds for one spent token to come back. */
    readonly intervalMs: number;
}

interface TokenCount {
    readonly tokens: number;
    readonly updatedAt: number;
}

/**
 * Tokens per key, in memory, refilled from elapsed time rather than by a timer.
 *
 * A key never seen holds a full count, so one whose tokens have all come back is
 * indistinguishable from one never seen — which is what lets {@link sweep} drop it.
 */
export class TokenLimit {
    private readonly counts = new Map<string, TokenCount>();

    constructor(private readonly options: TokenLimitOptions) {}

    /** Whether the key has a whole token to spend at `now`. */
    has(key: string, now: number): boolean {
        return this.tokensAt(key, now) >= 1;
    }

    /** Spend one of the key's tokens at `now`. The caller has checked {@link has}. */
    take(key: string, now: number): void {
        this.counts.set(key, { tokens: this.tokensAt(key, now) - 1, updatedAt: now });
    }

    /** Forget every key whose tokens have all come back by `now`. */
    sweep(now: number): void {
        for (const key of [...this.counts.keys()]) {
            if (this.tokensAt(key, now) >= this.options.limit) {
                this.counts.delete(key);
            }
        }
    }

    /** How many keys are held — for tests of the sweep. */
    get size(): number {
        return this.counts.size;
    }

    private tokensAt(key: string, now: number): number {
        const count = this.counts.get(key);
        if (!count) return this.options.limit;
        // A token back for every interval since the count was last updated, up to the limit.
        const tokens = count.tokens + Math.max(0, now - count.updatedAt) / this.options.intervalMs;
        return Math.min(this.options.limit, tokens);
    }
}

/** What a token was refused for, as the summary line counts it. */
export type MessageActivityKind = 'start' | 'wake';

export interface MessageActivityLimitOptions {
    readonly guild: TokenLimitOptions;
    readonly member: TokenLimitOptions;
    /** How often a guild's refusals are summed into one log line, at most. */
    readonly summaryIntervalMs: number;
}

interface RefusalCounts {
    start: number;
    wake: number;
}

/**
 * The flood limit on message activity: Message Sent run starts and live wake-ups of runs
 * waiting on a message. Nothing else draws from it — a join, a leave, a reaction, a
 * level-up or a button click is a one-off event, and dropping one loses it for good.
 *
 * Every draw takes one token from the guild and one from the member, and **both are
 * checked before either is taken**, so a member who has spent their share does not also
 * spend the guild's. A refusal drops a start and skips a wake-up; a skipped run stays
 * parked for the member's next message or its time limit.
 *
 * Refusals are logged as one summary line per guild per interval: the first refusal
 * schedules an `unref`'d timeout, and when it fires {@link flushSummary} writes a line
 * for every guild refused since, then forgets them. A process exiting first loses at
 * most one interval's line.
 */
export class MessageActivityLimit {
    private readonly guilds: TokenLimit;
    private readonly members: TokenLimit;
    private readonly refusals = new Map<string, RefusalCounts>();
    private pendingSummary: ReturnType<typeof setTimeout> | undefined;
    private lastSweepAt = 0;

    constructor(private readonly options: MessageActivityLimitOptions) {
        this.guilds = new TokenLimit(options.guild);
        this.members = new TokenLimit(options.member);
    }

    /**
     * Spend one guild token and one member token, or neither.
     *
     * @returns Whether the start or wake-up may go ahead.
     */
    take(guildId: string, userId: string, kind: MessageActivityKind, now: number = Date.now()): boolean {
        this.sweepWhenDue(now);

        // Snowflakes are digits, so the separator cannot occur inside either half.
        const memberKey = `${guildId}/${userId}`;
        if (!this.guilds.has(guildId, now) || !this.members.has(memberKey, now)) {
            this.countRefusal(guildId, kind);
            return false;
        }

        this.guilds.take(guildId, now);
        this.members.take(memberKey, now);
        return true;
    }

    /** Write one line per guild refused since the last summary, and forget them. */
    flushSummary(): void {
        clearTimeout(this.pendingSummary);
        this.pendingSummary = undefined;

        for (const [guildId, counts] of this.refusals) {
            console.warn(
                `[flows] Message limit: skipped ${counts.start} run start(s) and ${counts.wake} wake-up(s) ` +
                    `in guild ${guildId} — someone is flooding, or a flow is answering itself.`
            );
        }
        this.refusals.clear();
    }

    private countRefusal(guildId: string, kind: MessageActivityKind): void {
        const counts = this.refusals.get(guildId) ?? { start: 0, wake: 0 };
        counts[kind] += 1;
        this.refusals.set(guildId, counts);

        if (!this.pendingSummary) {
            this.pendingSummary = setTimeout(() => this.flushSummary(), this.options.summaryIntervalMs);
            this.pendingSummary.unref();
        }
    }

    /**
     * Drop keys whose tokens have all come back, at most once per summary interval, so a
     * guild that has seen many members does not hold one entry each forever.
     */
    private sweepWhenDue(now: number): void {
        if (now - this.lastSweepAt < this.options.summaryIntervalMs) return;
        this.lastSweepAt = now;
        this.guilds.sweep(now);
        this.members.sweep(now);
    }
}

/** The process's one message limit, at the defaults in `constants.ts`. */
export const messageActivityLimit = new MessageActivityLimit({
    guild: { limit: FLOW_MESSAGE_LIMIT_PER_GUILD, intervalMs: FLOW_MESSAGE_LIMIT_PER_GUILD_INTERVAL_MS },
    member: { limit: FLOW_MESSAGE_LIMIT_PER_MEMBER, intervalMs: FLOW_MESSAGE_LIMIT_PER_MEMBER_INTERVAL_MS },
    summaryIntervalMs: FLOW_MESSAGE_LIMIT_SUMMARY_INTERVAL_MS,
});
