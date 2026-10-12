import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppEnv } from '../../types';

/**
 * The leveling API contract.
 *
 * `levelingRoutes()` is a bare Hono app — `requireAuth` + `requireGuildAccess` are applied
 * once at the mount site in `api/index.ts` — so these tests inject a guild and a session
 * user directly and focus on what the route itself decides: the cap and its honesty flag,
 * how a departed member is reported, id validation, and the wire shape.
 *
 * The loaders are mocked. Whether `loadGuildLevelRankings` ranks correctly is settled in
 * its own test, and whether `buildStatsCardMetrics` computes a share percentage is settled
 * in the card's; re-proving either through HTTP would test them twice and the routing layer
 * not at all. What is only testable here is what the route does to their output — the
 * truncation boundary, the `Date` → ISO conversion, and the batching of member lookups.
 */

const loadGuildLevelRankings = vi.fn();
const loadUserLevelStats = vi.fn();
const loadLevelingInsights = vi.fn();
const fetchMemberSnapshotsById = vi.fn();

const levelingConfigRepoMock = {
    getByGuildId: vi.fn(),
};

/*
 * `parseStatsPeriod` is kept real via `importActual` rather than stubbed.
 *
 * A mock factory replaces the *whole* module, so every named export the route imports
 * alongside the mocked ones silently becomes `undefined` — and an undefined
 * `parseStatsPeriod` is not a readable assertion failure, it is a "not a function" 500.
 * Keeping it real is also the point of the period tests below: it is a pure string switch
 * with no I/O, so stubbing it would leave those tests asserting the stub's answer instead
 * of the period the route actually resolves and forwards.
 *
 * `LEVELING_LIST_CAP` needs no such treatment — the route exports it from itself, and that
 * module is not mocked, so importing it below reads the real bound the handler enforces.
 */
vi.mock('../../../features/leveling', async () => {
    const actual = await vi.importActual<typeof import('../../../features/leveling')>(
        '../../../features/leveling'
    );
    return {
        loadGuildLevelRankings,
        loadUserLevelStats,
        loadLevelingInsights,
        levelingConfigRepo: levelingConfigRepoMock,
        parseStatsPeriod: actual.parseStatsPeriod,
    };
});
vi.mock('../../../features/leveling/logic/fetchMemberSnapshots', () => ({ fetchMemberSnapshotsById }));

const { levelingRoutes, insightsBody, LEVELING_LIST_CAP } = await import('../levelingRoutes');

type LevelingInsights = Parameters<typeof insightsBody>[0];

const GUILD_ID = 'guild-1';
const USER_ID = '111111111111111111';
const SESSION_USER_ID = 'session-user';

interface RankingEntryOverrides {
    rank?: number;
    userId?: string;
    totalXp?: number;
    level?: number;
    messageCount?: number;
    reactionCount?: number;
    photoUploadCount?: number;
    lastActiveAt?: Date | null;
}

function rankingEntry(overrides: RankingEntryOverrides = {}) {
    return {
        rank: 1,
        userId: USER_ID,
        totalXp: 12_500,
        level: 14,
        messageCount: 980,
        reactionCount: 310,
        photoUploadCount: 27,
        lastActiveAt: new Date('2026-09-20T18:30:00.000Z'),
        ...overrides,
    };
}

function rankings(overrides: { entries?: unknown[]; totalRankedMembers?: number } = {}) {
    return {
        entries: [rankingEntry()],
        totalRankedMembers: 42,
        ...overrides,
    };
}

function memberSnapshot(overrides: Partial<{ userId: string; displayName: string; username: string; isBot: boolean; avatarUrl: string | null }> = {}) {
    return {
        userId: USER_ID,
        displayName: 'Kitten',
        username: 'kittenuser',
        isBot: false,
        avatarUrl: 'https://cdn.discordapp.com/avatars/111111111111111111/abc.png?size=128',
        ...overrides,
    };
}

function activityTotals(overrides: Partial<Record<string, number>> = {}) {
    return {
        activityDate: '2026-09-20',
        messageCount: 120,
        reactionCount: 44,
        photoUploadCount: 6,
        voiceSessionCount: 3,
        totalXp: 2_400,
        eventCount: 167,
        ...overrides,
    };
}

function progressRow(overrides: Record<string, unknown> = {}) {
    return {
        id: 1,
        guildId: GUILD_ID,
        userId: USER_ID,
        totalXp: 12_500,
        level: 14,
        messageCount: 980,
        reactionCount: 310,
        photoUploadCount: 27,
        voiceSessionCount: 18,
        totalVoiceSeconds: 46_800,
        lastMessageXpAt: new Date('2026-09-20T18:30:00.000Z'),
        lastReactionXpAt: new Date('2026-09-19T11:00:00.000Z'),
        lastVoiceXpAt: null,
        createdAt: new Date('2026-01-04T09:15:00.000Z'),
        updatedAt: new Date('2026-09-20T18:30:00.000Z'),
        ...overrides,
    };
}

function metrics(overrides: Record<string, unknown> = {}) {
    return {
        activityStatus: 'active',
        lastActiveAt: new Date('2026-09-20T18:30:00.000Z'),
        memberSince: new Date('2026-01-04T09:15:00.000Z'),
        tenureDays: 264,
        recentMsgsPerDay: 17.1,
        recentXpPerDay: 342.9,
        allTimeMsgsPerDay: 3.7,
        messageSharePercent: 72,
        reactionSharePercent: 26,
        voiceSharePercent: 2,
        photoRatePercent: 5,
        avgMessageLengthRecent: 84,
        avgXpPerMessageRecent: 20,
        dailyPeakEvents: 41,
        ...overrides,
    };
}

interface UserStatsOverrides {
    profile?: Record<string, unknown>;
    progress?: Record<string, unknown> | null;
    metrics?: Record<string, unknown>;
    statsPeriod?: 'week' | 'month' | 'year';
    activityChart?: Record<string, unknown>;
}

function userStats(overrides: UserStatsOverrides = {}) {
    return {
        profile: {
            userId: USER_ID,
            level: 14,
            totalXp: 12_500,
            xpWithinLevel: 500,
            xpToNextLevel: 900,
            xpForCurrentLevelStep: 1_400,
            recentActivity: activityTotals(),
            totalActivity: activityTotals({ messageCount: 980, eventCount: 1_308, totalXp: 12_500 }),
            recentPeriodDays: 7,
            hasAnyActivity: true,
            ...overrides.profile,
        },
        progress: overrides.progress === undefined ? progressRow() : overrides.progress,
        activityChart: {
            granularity: 'daily',
            buckets: [
                {
                    activityDate: '2026-09-20',
                    messageCount: 31,
                    reactionCount: 8,
                    photoUploadCount: 2,
                    voiceSessionCount: 1,
                },
            ],
            ...overrides.activityChart,
        },
        statsPeriod: overrides.statsPeriod ?? 'week',
        metrics: metrics(overrides.metrics),
    };
}

interface InsightsOverrides {
    trackedMembers?: number;
    topLevel?: number | null;
    levelReach?: unknown[];
    cohorts?: unknown[];
    xpDistribution?: Record<string, unknown> | null;
    firstActivityDate?: string | null;
    lastActivityDate?: string | null;
}

function insights(overrides: InsightsOverrides = {}) {
    return {
        trackedMembers: 391,
        topLevel: 34,
        levelReach: [
            { level: 2, membersReached: 300, percentReached: 77 },
            { level: 3, membersReached: 210, percentReached: 54 },
        ],
        cohorts: [
            {
                cohort: 'topQuarter',
                memberCount: 98,
                medianTotalXp: 18_400,
                medianLevel: 17,
                medianActiveDays: 62,
                progression: [{ level: 2, medianDays: 1, membersReached: 98, thin: false }],
            },
        ],
        xpDistribution: {
            typicalXp: 1_200,
            meanXp: 4_800,
            meanToTypicalRatio: 4,
            topMemberXp: 142_000,
            deciles: [10, 60, 180, 420, 1_200, 2_600, 5_100, 11_000, 29_000],
        },
        firstActivityDate: '2026-05-01',
        lastActivityDate: '2026-09-24',
        ...overrides,
    };
}

function insightsResult(overrides: { insights?: unknown; computedAt?: Date; cached?: boolean } = {}) {
    return {
        ok: true as const,
        insights: overrides.insights ?? insights(),
        computedAt: overrides.computedAt ?? new Date('2026-09-25T09:00:00.000Z'),
        cached: overrides.cached ?? false,
    };
}

/**
 * The router behind a middleware that sets both context variables.
 *
 * `guild` is what the handlers read, but `user` is set too: the router is mounted under
 * `requireAuth` in production, so a stub that omitted the session would be testing a
 * context the route never actually runs in.
 */
function app() {
    const outer = new Hono<AppEnv>();
    outer.use('*', async (c, next) => {
        c.set('guild', { id: GUILD_ID } as never);
        c.set('user', {
            id: SESSION_USER_ID,
            username: 'operator',
            avatar: null,
            manageableGuildIds: [GUILD_ID],
        });
        await next();
    });
    outer.route('/', levelingRoutes());
    return outer;
}

function get(path: string) {
    return app().request(`/${GUILD_ID}${path}`);
}

interface ErrorBody {
    error: string;
}

interface ListBody {
    entries: {
        rank: number;
        userId: string;
        member: { displayName: string; username: string; avatarUrl: string | null; isBot: boolean } | null;
        level: number;
        totalXp: number;
        lastActiveAt: string | null;
    }[];
    totalRankedMembers: number;
    truncated: boolean;
    enabled: boolean;
}

interface DetailBody {
    userId: string;
    member: { displayName: string } | null;
    level: number;
    totalXp: number;
    xpWithinLevel: number;
    hasAnyActivity: boolean;
    statsPeriod: string;
    recentPeriodDays: number;
    voiceSessionCount: number;
    totalVoiceSeconds: number;
    metrics: {
        activityStatus: string;
        lastActiveAt: string | null;
        memberSince: string | null;
        tenureDays: number;
    };
}

interface InsightsBody {
    trackedMembers: number;
    topLevel: number | null;
    levelReach: { level: number; membersReached: number; percentReached: number }[];
    cohorts: {
        cohort: string;
        memberCount: number;
        progression: { level: number; medianDays: number; thin: boolean }[];
    }[];
    xpDistribution: { typicalXp: number; meanXp: number; deciles: number[] } | null;
    firstActivityDate: string | null;
    lastActivityDate: string | null;
    computedAt: string;
    cached: boolean;
}

beforeEach(() => {
    vi.clearAllMocks();
    loadGuildLevelRankings.mockResolvedValue(rankings());
    loadUserLevelStats.mockResolvedValue(userStats());
    loadLevelingInsights.mockResolvedValue(insightsResult());
    fetchMemberSnapshotsById.mockResolvedValue(new Map([[USER_ID, memberSnapshot()]]));
    levelingConfigRepoMock.getByGuildId.mockResolvedValue({ guildId: GUILD_ID, enabled: true });
});

describe('GET /:guildId/leveling', () => {
    it('returns ranked entries with each member’s display details resolved', async () => {
        const response = await get('/leveling');
        const body = (await response.json()) as ListBody;

        expect(response.status).toBe(200);
        expect(body.entries).toHaveLength(1);
        expect(body.entries[0].rank).toBe(1);
        expect(body.entries[0].level).toBe(14);
        // A progress row carries only a snowflake, so the name is the thing the route adds.
        expect(body.entries[0].member).toEqual({
            userId: USER_ID,
            displayName: 'Kitten',
            username: 'kittenuser',
            avatarUrl: 'https://cdn.discordapp.com/avatars/111111111111111111/abc.png?size=128',
            isBot: false,
        });
    });

    it('reports a departed member as member: null rather than omitting the row', async () => {
        // They still hold XP, and their rank is still occupied. Dropping the row would
        // renumber the leaderboard around someone who left and quietly lose the fact that
        // the XP exists at all; a null is something the browser can label.
        fetchMemberSnapshotsById.mockResolvedValue(new Map());

        const body = (await (await get('/leveling')).json()) as ListBody;

        expect(body.entries).toHaveLength(1);
        expect(body.entries[0].userId).toBe(USER_ID);
        expect(body.entries[0].member).toBeNull();
        // The XP survives the missing member: that is the whole reason the row stays.
        expect(body.entries[0].totalXp).toBe(12_500);
    });

    /*
     * The cap and its honesty flag. The route asks for `CAP + 1` so it can tell "the cap
     * exactly" from "more than the cap"; both halves are pinned, because a table that
     * silently shows 100 of 4,000 members invites an operator to conclude the other 3,900
     * have no XP.
     */
    it('drops the sentinel row and reports truncated when the loader returns more than the cap', async () => {
        const overflowing = Array.from({ length: LEVELING_LIST_CAP + 1 }, (_entry, index) =>
            rankingEntry({ rank: index + 1, userId: `${900000000000000000 + index}` })
        );
        loadGuildLevelRankings.mockResolvedValue(rankings({ entries: overflowing }));

        const body = (await (await get('/leveling')).json()) as ListBody;

        expect(body.truncated).toBe(true);
        expect(body.entries).toHaveLength(LEVELING_LIST_CAP);
    });

    it('reports truncated false when the loader returns exactly the cap', async () => {
        const exact = Array.from({ length: LEVELING_LIST_CAP }, (_entry, index) =>
            rankingEntry({ rank: index + 1, userId: `${900000000000000000 + index}` })
        );
        loadGuildLevelRankings.mockResolvedValue(rankings({ entries: exact }));

        const body = (await (await get('/leveling')).json()) as ListBody;

        // The sentinel is the only thing distinguishing these two cases, so the boundary is
        // the whole point: one row fewer and nothing is being hidden.
        expect(body.truncated).toBe(false);
        expect(body.entries).toHaveLength(LEVELING_LIST_CAP);
    });

    it('asks the loader for exactly the cap plus one row', async () => {
        await get('/leveling');

        // Not the cap, and not the cap plus a page: the extra row is the sentinel the
        // `truncated` flag is derived from, so asking for the cap alone would make a full
        // page permanently indistinguishable from an overflowing one.
        expect(loadGuildLevelRankings).toHaveBeenCalledWith({
            guildId: GUILD_ID,
            limit: LEVELING_LIST_CAP + 1,
        });
    });

    it('reports guild-wide totalRankedMembers from the loader, not the page length', async () => {
        loadGuildLevelRankings.mockResolvedValue(
            rankings({ entries: [rankingEntry()], totalRankedMembers: 4_137 })
        );

        const body = (await (await get('/leveling')).json()) as ListBody;

        // Counted by the loader, not derived from the rows on the page: a footer that
        // agreed with the row count would describe the page rather than the guild, and
        // would silently contradict `truncated`.
        expect(body.totalRankedMembers).toBe(4_137);
        expect(body.entries).toHaveLength(1);
    });

    it('reports enabled false when the guild has no leveling config row at all', async () => {
        // No row is the pre-configuration state, not an error. Reporting `enabled: true`
        // from a missing row would tell an operator XP is accruing when nothing is.
        levelingConfigRepoMock.getByGuildId.mockResolvedValue(null);

        const response = await get('/leveling');
        const body = (await response.json()) as ListBody;

        expect(response.status).toBe(200);
        expect(body.enabled).toBe(false);
    });

    it('resolves member details in one batched call rather than one call per row', async () => {
        const manyEntries = Array.from({ length: 40 }, (_entry, index) =>
            rankingEntry({ rank: index + 1, userId: `${900000000000000000 + index}` })
        );
        loadGuildLevelRankings.mockResolvedValue(rankings({ entries: manyEntries }));

        await get('/leveling');

        // Forty sequential `members.fetch` round-trips would be forty chances to be rate
        // limited on a single page load; `fetchMemberSnapshotsById` batches by design and
        // the route has to hand it the whole id list to get that.
        expect(fetchMemberSnapshotsById).toHaveBeenCalledTimes(1);
        expect(fetchMemberSnapshotsById.mock.calls[0][1]).toHaveLength(40);
    });
});

describe('GET /:guildId/leveling/users/:userId', () => {
    it('returns the member’s level, XP and metrics', async () => {
        const response = await get(`/leveling/users/${USER_ID}`);
        const body = (await response.json()) as DetailBody;

        expect(response.status).toBe(200);
        expect(body.userId).toBe(USER_ID);
        expect(body.level).toBe(14);
        expect(body.totalXp).toBe(12_500);
        expect(body.xpWithinLevel).toBe(500);
        expect(body.member?.displayName).toBe('Kitten');
        expect(body.metrics.activityStatus).toBe('active');
        expect(body.metrics.tenureDays).toBe(264);
        // Voice lives on the progress row rather than the profile, so it is a separate
        // read the route has to remember to make.
        expect(body.voiceSessionCount).toBe(18);
        expect(body.totalVoiceSeconds).toBe(46_800);
    });

    it('serializes lastActiveAt and memberSince as ISO strings rather than Date objects', async () => {
        const body = (await (await get(`/leveling/users/${USER_ID}`)).json()) as DetailBody;

        /*
         * The route's declared `LevelingUserMetrics` schema says these are `string`.
         * Leaving them as `Date` and letting `JSON.stringify` deal with it would happen to
         * produce ISO today while putting no *contract* on the wire — and a later change to
         * a `toJSON`-less carrier would silently ship `{}`. The explicit conversion is what
         * makes the schema true, so the assertion is on the type, not just the value.
         */
        expect(typeof body.metrics.lastActiveAt).toBe('string');
        expect(typeof body.metrics.memberSince).toBe('string');
        expect(body.metrics.lastActiveAt).toBe('2026-09-20T18:30:00.000Z');
        expect(body.metrics.memberSince).toBe('2026-01-04T09:15:00.000Z');
    });

    it('reports a null timestamp as null rather than inventing an epoch date', async () => {
        loadUserLevelStats.mockResolvedValue(
            userStats({ metrics: { lastActiveAt: null, memberSince: null } })
        );

        const body = (await (await get(`/leveling/users/${USER_ID}`)).json()) as DetailBody;

        // `new Date(null)` is 1970, which would read as a real answer on the page.
        expect(body.metrics.lastActiveAt).toBeNull();
        expect(body.metrics.memberSince).toBeNull();
    });

    it.each(['abc', '12', '99999999999999999999999'])(
        '400s `%s`, which is not a snowflake',
        async (rawId) => {
            const response = await get(`/leveling/users/${rawId}`);

            expect(response.status).toBe(400);
            expect(((await response.json()) as ErrorBody).error).toContain(rawId);
            // Rejected before the query, not after: the check exists so a path segment
            // cannot reach a lookup, and a 400 handed back *after* loading proves nothing.
            // `'12'` and the 23-digit id are the two directions the length bound fails in.
            expect(loadUserLevelStats).not.toHaveBeenCalled();
        }
    );

    it('never reaches the loader with a traversal segment in the id', async () => {
        /*
         * Asserted as "the loader was not called" rather than as a 400, because `..` is
         * resolved by URL normalization *before* Hono matches: the request arrives as
         * `/guild-1/leveling/etc`, which matches no route and is a 404. The status is the
         * router's to decide; what matters to this route is that a traversal cannot arrive
         * at `loadUserLevelStats` as a user id, and that holds whichever layer stops it.
         */
        const response = await get('/leveling/users/../etc');

        expect(response.status).toBe(404);
        expect(loadUserLevelStats).not.toHaveBeenCalled();
        expect(fetchMemberSnapshotsById).not.toHaveBeenCalled();
    });

    it.each(['12345678901234567', '12345678901234567890'])(
        'accepts the valid snowflake %s',
        async (rawId) => {
            // The 17- and 20-digit ends of the range Discord actually issues, so a
            // tightened regex cannot quietly reject real ids at the boundary.
            const response = await get(`/leveling/users/${rawId}`);

            expect(response.status).toBe(200);
            expect(loadUserLevelStats).toHaveBeenCalledWith(GUILD_ID, rawId, { period: 'week' });
        }
    );

    it('passes the requested period through to the loader', async () => {
        await get(`/leveling/users/${USER_ID}?period=month`);

        // The period decides both the recent window and the chart granularity, so a route
        // that dropped it would render a week's chart under a "30 days" label.
        expect(loadUserLevelStats).toHaveBeenCalledWith(GUILD_ID, USER_ID, { period: 'month' });
    });

    it.each([
        ['absent', ''],
        ['nonsense', '?period=fortnight'],
        ['empty', '?period='],
    ])('falls back to the default period when it is %s', async (_label, query) => {
        await get(`/leveling/users/${USER_ID}${query}`);

        // A 400 here would be the wrong shape: the period is a view preference with a
        // sensible default, not an identifier, so an unrecognized one degrades to `week`
        // rather than refusing to show the member at all.
        expect(loadUserLevelStats).toHaveBeenCalledWith(GUILD_ID, USER_ID, { period: 'week' });
    });

    it('answers for a member with no progress at all rather than 404ing', async () => {
        /*
         * "This member has earned nothing yet" is a real answer an operator asked for, and
         * `loadUserLevelStats` answers for anyone. A 404 is reserved for the malformed id
         * the tests above cover — reusing it here would make "not a user" and "quiet user"
         * indistinguishable on the page.
         */
        loadUserLevelStats.mockResolvedValue(
            userStats({
                progress: null,
                profile: {
                    level: 1,
                    totalXp: 0,
                    xpWithinLevel: 0,
                    hasAnyActivity: false,
                    recentActivity: activityTotals({
                        messageCount: 0,
                        reactionCount: 0,
                        photoUploadCount: 0,
                        voiceSessionCount: 0,
                        totalXp: 0,
                        eventCount: 0,
                    }),
                },
                metrics: { activityStatus: 'none', lastActiveAt: null, memberSince: null, tenureDays: 1 },
            })
        );

        const response = await get(`/leveling/users/${USER_ID}`);
        const body = (await response.json()) as DetailBody;

        expect(response.status).toBe(200);
        expect(body.level).toBe(1);
        expect(body.totalXp).toBe(0);
        expect(body.hasAnyActivity).toBe(false);
        expect(body.metrics.activityStatus).toBe('none');
        // Voice falls back to zero rather than crashing on the absent progress row.
        expect(body.voiceSessionCount).toBe(0);
        expect(body.totalVoiceSeconds).toBe(0);
    });

    it('reports a member who has left as member: null while still answering with their stats', async () => {
        fetchMemberSnapshotsById.mockResolvedValue(new Map());

        const body = (await (await get(`/leveling/users/${USER_ID}`)).json()) as DetailBody;

        expect(body.member).toBeNull();
        expect(body.totalXp).toBe(12_500);
    });
});

describe('GET /:guildId/leveling/insights', () => {
    it('returns the report with computedAt as an ISO string rather than a Date', async () => {
        const response = await get('/leveling/insights');
        const body = (await response.json()) as InsightsBody;

        expect(response.status).toBe(200);
        expect(body.trackedMembers).toBe(391);
        expect(body.topLevel).toBe(34);
        expect(body.levelReach).toHaveLength(2);
        expect(body.cohorts[0].cohort).toBe('topQuarter');
        // Two levels deep, and the level the gate is thinnest at: a progression point that
        // lost its `thin` flag on the way out would mark a three-person median as a fact.
        expect(body.cohorts[0].progression[0].thin).toBe(false);
        expect(body.xpDistribution?.deciles).toHaveLength(9);

        expect(typeof body.computedAt).toBe('string');
        expect(body.computedAt).toBe('2026-09-25T09:00:00.000Z');
    });

    // The conversion itself is asserted on `insightsBody` below, where it can actually fail:
    // `JSON.stringify` turns a `Date` into the same ISO text, so this pair only pins the
    // value the page reads, not the route's ownership of the format.

    it('reports cached straight through from the loader', async () => {
        loadLevelingInsights.mockResolvedValue(insightsResult({ cached: true }));

        const body = (await (await get('/leveling/insights')).json()) as InsightsBody;

        // The page says "as of a minute ago" off this flag. Hard-coding it either way would
        // make a five-minute-old report indistinguishable from a fresh scan.
        expect(body.cached).toBe(true);
    });

    it('503s when the loader refuses the scan, naming the count and the ceiling', async () => {
        loadLevelingInsights.mockResolvedValue({
            ok: false,
            refusal: 'too-many-events',
            eventCount: 1_200_000,
            ceiling: 750_000,
        });

        const response = await get('/leveling/insights');
        const body = (await response.json()) as ErrorBody;

        /*
         * 503, not 400 and not 500: the request is well-formed and nothing is broken — the
         * guild is simply too large to scan without stalling the bot for everyone, which is
         * the one condition that means "ask again later".
         */
        expect(response.status).toBe(503);
        // The numbers are the actionable part. "Too big" without them tells an operator
        // nothing about how far over they are or whether trimming history would help.
        expect(body.error).toContain('1,200,000');
        expect(body.error).toContain('750,000');
    });

    it('answers 200 for a guild with no activity at all, keeping the nulls', async () => {
        /*
         * A brand-new guild is the shape most likely to crash a report built on maxima and
         * medians: `topLevel` and `xpDistribution` are null by design rather than zeroed,
         * and the mapping has to carry that through instead of reading a field off null.
         */
        loadLevelingInsights.mockResolvedValue(
            insightsResult({
                insights: insights({
                    trackedMembers: 0,
                    topLevel: null,
                    levelReach: [],
                    cohorts: [],
                    xpDistribution: null,
                    firstActivityDate: null,
                    lastActivityDate: null,
                }),
            })
        );

        const response = await get('/leveling/insights');
        const body = (await response.json()) as InsightsBody;

        expect(response.status).toBe(200);
        expect(body.trackedMembers).toBe(0);
        // Null rather than 0: a zero here would render as "level 0", a level nobody holds.
        expect(body.topLevel).toBeNull();
        expect(body.xpDistribution).toBeNull();
        expect(body.firstActivityDate).toBeNull();
        expect(body.levelReach).toEqual([]);
        expect(body.cohorts).toEqual([]);
    });

    it('asks the loader for the guild in context', async () => {
        await get('/leveling/insights');

        expect(loadLevelingInsights).toHaveBeenCalledWith(GUILD_ID);
    });

});

describe('insightsBody', () => {
    /*
     * Asserted on the mapper rather than through the route, and that is the whole point.
     *
     * `c.json` serializes immediately, so the JSON a route test reads back is a fresh object
     * no matter what this function did — an aliasing test via HTTP passes with every copy
     * removed, which was verified rather than assumed. The invariant is only observable on
     * the returned object.
     *
     * It matters because the loader caches one insights object per guild for five minutes and
     * hands the *same* one to every caller in that window: an aliased array that anything
     * downstream sorts, reverses or pushes to would rewrite what the next request serves,
     * with no second scan to put it back.
     */
    it('copies the cached report’s arrays instead of aliasing them', () => {
        const cached = insights() as unknown as LevelingInsights;

        const body = insightsBody(cached, new Date('2026-09-25T09:00:00.000Z'), false);

        body.levelReach.length = 0;
        body.cohorts[0].progression.length = 0;
        body.xpDistribution?.deciles.push(999_999);

        expect(cached.levelReach).toHaveLength(2);
        expect(cached.cohorts[0].progression).toHaveLength(1);
        expect(cached.xpDistribution?.deciles).toHaveLength(9);
    });

    it('converts computedAt to an ISO string rather than carrying the Date', () => {
        // On the returned object, where it is still a `Date` unless the mapper converted it —
        // via HTTP `JSON.stringify` would produce the same ISO text either way.
        const body = insightsBody(
            insights() as unknown as LevelingInsights,
            new Date('2026-09-25T09:00:00.000Z'),
            false
        );

        expect(typeof body.computedAt).toBe('string');
        expect(body.computedAt).toBe('2026-09-25T09:00:00.000Z');
    });
});
