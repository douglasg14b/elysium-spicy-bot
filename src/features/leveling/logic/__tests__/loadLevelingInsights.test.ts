import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The cache standing between a dashboard refresh and a stalled bot.
 *
 * On SQLite this repo holds one *synchronous* connection, so the guild scan is time the
 * whole process spends unable to answer anything — not merely time this caller waits. That
 * makes the TTL and the in-flight coalescing load-bearing rather than tidy, and neither is
 * visible in a type. These are the tests that make them real.
 */

const countGuildEvents = vi.fn();
const getGuildEventTimeline = vi.fn();

vi.mock('../../data/levelingXpGrantRepo', () => ({
    levelingXpGrantRepo: {
        countGuildEvents: (...args: unknown[]) => countGuildEvents(...args),
        getGuildEventTimeline: (...args: unknown[]) => getGuildEventTimeline(...args),
    },
}));

const { loadLevelingInsights, clearLevelingInsightsCache, INSIGHTS_TTL_MS, INSIGHTS_EVENT_CEILING } =
    await import('../loadLevelingInsights');

const GUILD_ID = 'guild-1';
const START = new Date('2026-01-01T12:00:00.000Z');

/** One member, one day, enough XP to be interesting. */
function anEvent(userId = 'user-1') {
    return { userId, occurredAt: new Date('2026-01-01T10:00:00.000Z'), xpAmount: 200 };
}

describe('loadLevelingInsights', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        clearLevelingInsightsCache();
        countGuildEvents.mockResolvedValue(1);
        getGuildEventTimeline.mockResolvedValue([anEvent()]);
    });

    it('computes a report on the first call', async () => {
        const result = await loadLevelingInsights(GUILD_ID, { now: START });

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.cached).toBe(false);
        expect(result.insights.trackedMembers).toBe(1);
    });

    it('serves the cached report inside the TTL without touching the database', async () => {
        await loadLevelingInsights(GUILD_ID, { now: START });
        getGuildEventTimeline.mockClear();
        countGuildEvents.mockClear();

        const result = await loadLevelingInsights(GUILD_ID, {
            now: new Date(START.getTime() + INSIGHTS_TTL_MS - 1),
        });

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.cached).toBe(true);
        // The point of the whole exercise: no scan, so no stalled bot.
        expect(getGuildEventTimeline).not.toHaveBeenCalled();
        expect(countGuildEvents).not.toHaveBeenCalled();
    });

    it('recomputes once the TTL has passed', async () => {
        /*
         * The clock is faked rather than injected here. `computedAt` is stamped inside the
         * computation from the real clock — deliberately, so the TTL measures how old the
         * answer actually is — so an injected `now` far in the future ages the *first* entry
         * but the recompute then stores a present-day stamp, and reading `cached` on a third
         * call would compare a future `now` against it. Faking the clock keeps both sides on
         * one timeline, which is the only way this assertion means anything.
         */
        vi.useFakeTimers();
        vi.setSystemTime(START);

        try {
            await loadLevelingInsights(GUILD_ID);

            vi.setSystemTime(new Date(START.getTime() + INSIGHTS_TTL_MS));
            const result = await loadLevelingInsights(GUILD_ID);

            expect(result.ok).toBe(true);
            if (!result.ok) return;
            expect(result.cached).toBe(false);
            expect(getGuildEventTimeline).toHaveBeenCalledTimes(2);
        } finally {
            vi.useRealTimers();
        }
    });

    it('stamps the report when the work finished, not when it started', async () => {
        /*
         * Taking the timestamp before the scan charged the report for the scan's own duration,
         * so it entered the cache already that much nearer expiry. On a slow guild that is the
         * difference between a five-minute TTL and a four-minute one, silently.
         */
        vi.useFakeTimers();
        vi.setSystemTime(START);

        try {
            getGuildEventTimeline.mockImplementation(async () => {
                // The scan takes a minute of wall clock.
                vi.setSystemTime(new Date(START.getTime() + 60_000));
                return [anEvent()];
            });

            const result = await loadLevelingInsights(GUILD_ID);

            expect(result.ok).toBe(true);
            if (!result.ok) return;
            expect(result.computedAt.getTime()).toBe(START.getTime() + 60_000);
        } finally {
            vi.useRealTimers();
        }
    });

    it('caches per guild rather than globally', async () => {
        await loadLevelingInsights(GUILD_ID, { now: START });
        await loadLevelingInsights('guild-2', { now: START });

        // A shared cache would serve one server's report as another's — the worst possible
        // failure for a per-guild dashboard.
        expect(getGuildEventTimeline).toHaveBeenCalledTimes(2);
        expect(getGuildEventTimeline).toHaveBeenCalledWith(GUILD_ID, INSIGHTS_EVENT_CEILING + 1);
        expect(getGuildEventTimeline).toHaveBeenCalledWith('guild-2', INSIGHTS_EVENT_CEILING + 1);
    });

    it('scans once for a burst of simultaneous callers', async () => {
        /*
         * The TTL alone does not help here: three dashboard loads inside the same second each
         * miss the cache, because none has finished writing it yet. Without coalescing they
         * each start a scan and each blocks the bot in turn.
         */
        let release: (rows: unknown[]) => void = () => undefined;
        getGuildEventTimeline.mockReturnValue(
            new Promise((resolve) => {
                release = resolve;
            })
        );

        const calls = [
            loadLevelingInsights(GUILD_ID, { now: START }),
            loadLevelingInsights(GUILD_ID, { now: START }),
            loadLevelingInsights(GUILD_ID, { now: START }),
        ];

        release([anEvent()]);
        const results = await Promise.all(calls);

        expect(getGuildEventTimeline).toHaveBeenCalledTimes(1);
        expect(results.every((result) => result.ok)).toBe(true);
    });

    it('lets a later caller retry after a failed scan', async () => {
        // The `finally` that clears the in-flight entry. Without it one database blip would
        // wedge the guild's insights behind a rejected promise for the life of the process.
        getGuildEventTimeline.mockRejectedValueOnce(new Error('database went away'));

        await expect(loadLevelingInsights(GUILD_ID, { now: START })).rejects.toThrow('database went away');

        getGuildEventTimeline.mockResolvedValue([anEvent()]);
        const result = await loadLevelingInsights(GUILD_ID, { now: START });

        expect(result.ok).toBe(true);
    });

    describe('when the guild is too large to scan', () => {
        beforeEach(() => {
            countGuildEvents.mockResolvedValue(INSIGHTS_EVENT_CEILING + 1);
        });

        it('refuses by count without reading a single row', async () => {
            const result = await loadLevelingInsights(GUILD_ID, { now: START });

            expect(result.ok).toBe(false);
            if (result.ok) return;
            expect(result.refusal).toBe('too-many-events');
            expect(result.eventCount).toBe(INSIGHTS_EVENT_CEILING + 1);
            // Refused *before* paying for the scan, which is the only moment refusing helps.
            expect(getGuildEventTimeline).not.toHaveBeenCalled();
        });

        it('caches the refusal so a polling dashboard does not re-count forever', async () => {
            await loadLevelingInsights(GUILD_ID, { now: START });
            countGuildEvents.mockClear();

            const result = await loadLevelingInsights(GUILD_ID, {
                now: new Date(START.getTime() + INSIGHTS_TTL_MS - 1),
            });

            expect(result.ok).toBe(false);
            // The guilds least able to afford database work were otherwise the only ones
            // doing it on every request: the success path had a TTL and this path had none.
            expect(countGuildEvents).not.toHaveBeenCalled();
        });
    });

    it('refuses on what it actually read, not only on the earlier count', async () => {
        /*
         * The count and the scan are two queries, and `grantXp` writes a row on every message.
         * A guild just under the ceiling at count time can be over it at read time, so the
         * limit has to hold on the rows in hand.
         */
        countGuildEvents.mockResolvedValue(INSIGHTS_EVENT_CEILING - 1);
        getGuildEventTimeline.mockResolvedValue(
            Array.from({ length: INSIGHTS_EVENT_CEILING + 1 }, () => anEvent())
        );

        const result = await loadLevelingInsights(GUILD_ID, { now: START });

        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.refusal).toBe('too-many-events');
    });
});
