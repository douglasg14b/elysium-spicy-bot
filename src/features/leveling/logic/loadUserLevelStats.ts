import { levelingActivityEventRepo } from '../data/levelingActivityEventRepo';
import { levelingProgressRepo } from '../data/levelingProgressRepo';
import {
    aggregateActivityTotals,
    aggregateDailyIntoWeeklyBuckets,
    aggregateEventsByDate,
    fillActivityDateRange,
    filterEventsByActivityDateRange,
    getActivityDateKey,
    getActivityDateStart,
    subtractActivityDays,
} from './activityEventAggregation';
import { buildUserLevelProfile, type UserLevelProfile } from './userLevelProfile';
import {
    DEFAULT_STATS_PERIOD,
    getStatsPeriodDays,
    resolveActivityChartGranularity,
    type ActivityChartGranularity,
    type StatsPeriod,
} from './statsPeriod';
import { buildStatsCardMetrics, type StatsCardMetrics } from '../cards/statsCard/statsCardMetrics';
import type { DailyActivityBucket } from '../data/levelingActivityEventSchema';
import type { LevelingProgress } from '../data/levelingProgressSchema';

export type ActivityChart = {
    buckets: DailyActivityBucket[];
    granularity: ActivityChartGranularity;
};

export type UserLevelStats = {
    profile: UserLevelProfile;
    progress: LevelingProgress | null;
    activityChart: ActivityChart;
    statsPeriod: StatsPeriod;
    metrics: StatsCardMetrics;
};

export type LoadUserLevelStatsOptions = {
    period?: StatsPeriod;
    now?: Date;
};

function getRecentActivityDateRange(now: Date, days: number): { startDate: string; endDate: string } {
    const endDate = getActivityDateKey(now);
    const startDate = getActivityDateKey(subtractActivityDays(now, days - 1));
    return { startDate, endDate };
}

function resolveActivityChart(
    dailyBuckets: DailyActivityBucket[],
    periodDays: number
): ActivityChart {
    const granularity = resolveActivityChartGranularity(periodDays);

    if (granularity === 'weekly') {
        return {
            buckets: aggregateDailyIntoWeeklyBuckets(dailyBuckets),
            granularity,
        };
    }

    return {
        buckets: dailyBuckets,
        granularity,
    };
}

export async function loadUserLevelStats(
    guildId: string,
    userId: string,
    options: LoadUserLevelStatsOptions = {}
): Promise<UserLevelStats> {
    const now = options.now ?? new Date();
    const statsPeriod = options.period ?? DEFAULT_STATS_PERIOD;
    const periodDays = getStatsPeriodDays(statsPeriod);
    const { startDate, endDate } = getRecentActivityDateRange(now, periodDays);
    const since = subtractActivityDays(getActivityDateStart(startDate), 1);

    const [progress, recentEventsRaw, totalActivity] = await Promise.all([
        levelingProgressRepo.get(guildId, userId),
        levelingActivityEventRepo.getUserEvents(guildId, userId, { since }),
        levelingActivityEventRepo.getUserActivityTotals(guildId, userId),
    ]);

    const recentEvents = filterEventsByActivityDateRange(recentEventsRaw, startDate, endDate);
    const recentActivity = aggregateActivityTotals(recentEvents);
    const dailyActivity = fillActivityDateRange(aggregateEventsByDate(recentEvents), startDate, endDate);
    const activityChart = resolveActivityChart(dailyActivity, periodDays);

    const profile = buildUserLevelProfile({
        userId,
        progress,
        recentActivity,
        totalActivity,
        recentPeriodDays: periodDays,
        now,
    });

    const metrics = buildStatsCardMetrics({
        progress,
        recentActivity,
        totalActivity,
        recentEvents,
        chartBuckets: activityChart.buckets,
        recentPeriodDays: periodDays,
        now,
    });

    return {
        profile,
        progress,
        activityChart,
        statsPeriod,
        metrics,
    };
}
