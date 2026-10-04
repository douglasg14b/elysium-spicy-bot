import { z } from '@hono/zod-openapi';
/*
 * The vocabularies come from the modules that define them, not the `features/leveling`
 * barrel: `levelingRoutes.test.ts` mocks the barrel down to the loaders it stubs, and
 * `z.enum` reads these at load, so a barrel import would build every enum from `undefined`.
 */
import { ACTIVITY_STATUSES } from '../../features/leveling/cards/statsCard/statsCardMetrics';
import { COHORT_KEYS } from '../../features/leveling/logic/levelingCohorts';
import { STATS_PERIODS } from '../../features/leveling/logic/statsPeriod';

/**
 * The leveling shapes the browser receives.
 *
 * Each is a zod schema, and the schema **is** the contract: `levelingRoutes` declares it
 * on its routes, `router.openapi` type-checks every `c.json(...)` against it, and the spec
 * the dashboard SDK is generated from names it as a component. The `.openapi('Name')` ids
 * are the names the dashboard imports by, and follow the browser's names for these shapes.
 *
 * The builders in `levelingRoutes.ts` are typed by `z.infer` of these schemas, so a member
 * the schema does not describe is a compile error where the body is built. Arrays stay
 * mutable: the builders copy every array out of the loaders' cached objects, and
 * `insightsBody`'s test proves the copy by mutating what it returns.
 *
 * Every schema here is made with `@hono/zod-openapi`'s `z`; see `FlowGraphSchema` in
 * `flowBody.ts` for why a schema made in `src/features` cannot be named.
 */

/**
 * The window a member's stats are computed over, shortest first — the order the period
 * picker offers them in. Named so the browser reads the picker's options off it.
 */
const StatsPeriodSchema = z.enum(STATS_PERIODS).openapi('StatsPeriod', {
    description: 'The window a member’s stats cover, shortest first.',
});

/** How recently a member has been active. The member page's badge switches on it. */
const ActivityStatusSchema = z.enum(ACTIVITY_STATUSES).openapi('ActivityStatus', {
    description: 'How recently a member has been active.',
});

/**
 * The bands the insights report splits a server into, least to most active — the order
 * the chart legend lists them in. `topOnePercent` overlaps `topQuarter` by design.
 */
const CohortKeySchema = z.enum(COHORT_KEYS).openapi('CohortKey', {
    description:
        'A band of members by XP within this server, least to most active. `topOnePercent` is a ' +
        'spotlight inside `topQuarter`, not a fifth band, so the counts do not sum.',
});

/** A member as Discord currently knows them, resolved beside their stored progress. */
const LevelingMemberSchema = z
    .object({
        userId: z.string(),
        displayName: z.string(),
        username: z.string(),
        avatarUrl: z.string().nullable(),
        isBot: z.boolean(),
    })
    .openapi('LevelingMember', {
        description: 'A member as Discord knows them now. `avatarUrl` is null when they have no avatar.',
    });

export type LevelingMember = z.infer<typeof LevelingMemberSchema>;

/** A row on the leaderboard. */
const LevelingRankingRowSchema = z
    .object({
        rank: z.number(),
        userId: z.string(),
        // A union rather than `.nullable()`: the generator copies a named schema's name onto
        // its nullable variant, so `LevelingMember` itself would become nullable.
        member: z.union([LevelingMemberSchema, z.null()]),
        level: z.number(),
        totalXp: z.number(),
        messageCount: z.number(),
        reactionCount: z.number(),
        photoUploadCount: z.number(),
        lastActiveAt: z.string().nullable(),
    })
    .openapi('LevelingRankingRow', {
        description:
            'A row on the leaderboard. `member` is null when they have left the server but still hold XP.',
    });

export type LevelingRankingRow = z.infer<typeof LevelingRankingRowSchema>;

/** The body of `GET /leveling`. */
export const LevelingListResultSchema = z
    .object({
        entries: z.array(LevelingRankingRowSchema),
        totalRankedMembers: z.number(),
        truncated: z.boolean(),
        enabled: z.boolean(),
    })
    .openapi('LevelingListResult', {
        description:
            'The leaderboard, capped. `truncated` means more members rank than are listed; ' +
            '`totalRankedMembers` is the whole server either way. `enabled` is whether leveling is on.',
    });

export type LevelingListResult = z.infer<typeof LevelingListResultSchema>;

/** What a member did over a window, counted. */
const LevelingActivitySummarySchema = z
    .object({
        messageCount: z.number(),
        reactionCount: z.number(),
        photoUploadCount: z.number(),
        voiceSessionCount: z.number(),
        totalXp: z.number(),
        eventCount: z.number(),
    })
    .openapi('LevelingActivitySummary', { description: 'What a member did over a window, counted.' });

export type LevelingActivitySummary = z.infer<typeof LevelingActivitySummarySchema>;

/** One bar on the member page's activity chart: a day, or a week. */
const LevelingActivityBucketSchema = z
    .object({
        activityDate: z.string(),
        messageCount: z.number(),
        reactionCount: z.number(),
        photoUploadCount: z.number(),
        voiceSessionCount: z.number(),
    })
    .openapi('LevelingActivityBucket', {
        description: 'One bar of the activity chart. `activityDate` is the day, or the first day of the week.',
    });

const LevelingActivityChartSchema = z
    .object({
        granularity: z.enum(['daily', 'weekly']),
        buckets: z.array(LevelingActivityBucketSchema),
    })
    .openapi('LevelingActivityChart', {
        description: 'The activity chart. The period decides whether a bar is a day or a week.',
    });

/** The figures `/level-stats` puts on its card, for the member page. */
const LevelingUserMetricsSchema = z
    .object({
        activityStatus: ActivityStatusSchema,
        lastActiveAt: z.string().nullable(),
        memberSince: z.string().nullable(),
        tenureDays: z.number(),
        recentMsgsPerDay: z.number(),
        recentXpPerDay: z.number(),
        allTimeMsgsPerDay: z.number(),
        messageSharePercent: z.number(),
        reactionSharePercent: z.number(),
        voiceSharePercent: z.number(),
        photoRatePercent: z.number(),
        avgMessageLengthRecent: z.number().nullable(),
        avgXpPerMessageRecent: z.number().nullable(),
        dailyPeakEvents: z.number(),
    })
    .openapi('LevelingUserMetrics', {
        description: 'The figures the stats card shows. Timestamps are ISO, null when never.',
    });

/** The body of `GET /leveling/users/{userId}`. */
export const LevelingUserDetailSchema = z
    .object({
        userId: z.string(),
        member: z.union([LevelingMemberSchema, z.null()]),
        level: z.number(),
        totalXp: z.number(),
        xpWithinLevel: z.number(),
        xpToNextLevel: z.number(),
        xpForCurrentLevelStep: z.number(),
        hasAnyActivity: z.boolean(),
        statsPeriod: StatsPeriodSchema,
        recentPeriodDays: z.number(),
        recentActivity: LevelingActivitySummarySchema,
        totalActivity: LevelingActivitySummarySchema,
        voiceSessionCount: z.number(),
        totalVoiceSeconds: z.number(),
        activityChart: LevelingActivityChartSchema,
        metrics: LevelingUserMetricsSchema,
    })
    .openapi('LevelingUserDetail', {
        description:
            "One member's level, XP and activity. A member with no progress is level 1 with nothing " +
            'recorded, not a 404. `statsPeriod` is the window actually aggregated.',
    });

export type LevelingUserDetail = z.infer<typeof LevelingUserDetailSchema>;

/** One point on the "how many members ever got this far" curve. */
const LevelingLevelReachPointSchema = z
    .object({
        level: z.number(),
        membersReached: z.number(),
        percentReached: z.number(),
    })
    .openapi('LevelingLevelReachPoint', {
        description: 'How many members ever reached a level. `percentReached` is 0–100 of tracked members.',
    });

export type LevelingLevelReachPoint = z.infer<typeof LevelingLevelReachPointSchema>;

const LevelingCohortProgressionPointSchema = z
    .object({
        level: z.number(),
        medianDays: z.number(),
        membersReached: z.number(),
        thin: z.boolean(),
    })
    .openapi('LevelingCohortProgressionPoint', {
        description: 'How long a cohort took to reach a level. `thin` means too few members to call it typical.',
    });

export type LevelingCohortProgressionPoint = z.infer<typeof LevelingCohortProgressionPointSchema>;

const LevelingCohortSummarySchema = z
    .object({
        cohort: CohortKeySchema,
        memberCount: z.number(),
        medianTotalXp: z.number(),
        medianLevel: z.number(),
        medianActiveDays: z.number(),
        progression: z.array(LevelingCohortProgressionPointSchema),
    })
    .openapi('LevelingCohortSummary', {
        description: 'One cohort. `medianActiveDays` counts days a member earned something, not days since joining.',
    });

export type LevelingCohortSummary = z.infer<typeof LevelingCohortSummarySchema>;

const LevelingXpDistributionSchema = z
    .object({
        typicalXp: z.number(),
        meanXp: z.number(),
        meanToTypicalRatio: z.number(),
        topMemberXp: z.number(),
        deciles: z.array(z.number()),
    })
    .openapi('LevelingXpDistribution', { description: 'How lopsided the XP is.' });

export type LevelingXpDistribution = z.infer<typeof LevelingXpDistributionSchema>;

/** The body of `GET /leveling/insights`. */
export const LevelingInsightsBodySchema = z
    .object({
        trackedMembers: z.number(),
        topLevel: z.number().nullable(),
        levelReachTruncated: z.boolean(),
        levelReach: z.array(LevelingLevelReachPointSchema),
        cohorts: z.array(LevelingCohortSummarySchema),
        xpDistribution: z.union([LevelingXpDistributionSchema, z.null()]),
        firstActivityDate: z.string().nullable(),
        lastActivityDate: z.string().nullable(),
        computedAt: z.string(),
        cached: z.boolean(),
    })
    .openapi('LevelingInsightsBody', {
        description:
            'The guild-wide insights report. `topLevel` is null when nobody has earned anything, and can ' +
            'pass the end of `levelReach` — `levelReachTruncated` says when. `xpDistribution` is null with ' +
            'no XP to describe. `computedAt` is ISO; `cached` means it came from the five-minute cache.',
    });

export type LevelingInsightsBody = z.infer<typeof LevelingInsightsBodySchema>;
