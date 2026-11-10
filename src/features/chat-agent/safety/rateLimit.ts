const MINUTE_MS = 60_000;

export type RateLimitSettings = {
    /** Turns one member may start in {@link windowMs}. */
    readonly maxTurns: number;
    readonly windowMs: number;
    /** How long a member who went past the limit is ignored. */
    readonly cooldownMs: number;
};

const DEFAULT_RATE_LIMIT: RateLimitSettings = {
    maxTurns: 4,
    windowMs: MINUTE_MS,
    cooldownMs: 5 * MINUTE_MS,
};

/**
 * What to do with a member's turn: `allow` it, `warn` them once (the turn that crossed
 * the limit, which also starts the cooldown), or `ignore` it silently until it ends.
 */
export type RateLimitDecision = 'allow' | 'warn' | 'ignore';

type MemberWindow = { turnTimes: number[]; cooldownUntil: number };

/**
 * Per-member turn limit, in memory, keyed by guild and user. Losing it on restart is
 * fine: it only exists to stop one person hammering the model.
 */
export class ChatRateLimiter {
    private readonly windows = new Map<string, MemberWindow>();

    constructor(private readonly settings: RateLimitSettings = DEFAULT_RATE_LIMIT) {}

    /** Records the attempt and decides it. */
    attempt(guildId: string, userId: string, now: number = Date.now()): RateLimitDecision {
        this.forgetIdle(now);
        const key = `${guildId}:${userId}`;
        const window = this.windows.get(key) ?? { turnTimes: [], cooldownUntil: 0 };
        this.windows.set(key, window);

        if (now < window.cooldownUntil) return 'ignore';

        window.turnTimes = window.turnTimes.filter((time) => now - time < this.settings.windowMs);
        if (window.turnTimes.length >= this.settings.maxTurns) {
            window.turnTimes = [];
            window.cooldownUntil = now + this.settings.cooldownMs;
            return 'warn';
        }

        window.turnTimes.push(now);
        return 'allow';
    }

    /** Drops members with no turn in the window and no cooldown running, so the map holds only the active. */
    private forgetIdle(now: number): void {
        for (const [key, window] of this.windows) {
            const lastTurn = window.turnTimes.at(-1) ?? -Infinity;
            if (now >= window.cooldownUntil && now - lastTurn >= this.settings.windowMs) this.windows.delete(key);
        }
    }
}
