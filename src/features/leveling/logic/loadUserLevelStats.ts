import { LEVELING_RECENT_ACTIVITY_DAYS } from '../constants';
import { levelingActivityEventRepo } from '../data/levelingActivityEventRepo';
import { levelingProgressRepo } from '../data/levelingProgressRepo';
import {
    aggregateActivityTotals,
    aggregateEventsByDate,
    fillActivityDateRange,
    getActivityDateKey,
    subtractActivityDays,
} from './activityEventAggregation';
import { buildUserLevelProfile, getRecentActivitySince, type UserLevelProfile } from './userLevelProfile';
import { buildStatsCardMetrics, type StatsCardMetrics } from '../cards/statsCard/statsCardMetrics';
import type { DailyActivityBucket } from '../data/levelingActivityEventSchema';
import type { LevelingProgress } from '../data/levelingProgressSchema';

export type UserLevelStats = {
    profile: UserLevelProfile;
    progress: LevelingProgress | null;
    dailyActivity: DailyActivityBucket[];
    metrics: StatsCardMetrics;
};

function getRecentActivityDateRange(now: Date, days: number): { startDate: string; endDate: string } {
    const endDate = getActivityDateKey(now);
    const startDate = getActivityDateKey(subtractActivityDays(now, days - 1));
    return { startDate, endDate };
}

export async function loadUserLevelStats(guildId: string, userId: string): Promise<UserLevelStats> {
    const since = getRecentActivitySince();
    const { startDate, endDate } = getRecentActivityDateRange(new Date(), LEVELING_RECENT_ACTIVITY_DAYS);

    const [progress, recentEvents, totalActivity] = await Promise.all([
        levelingProgressRepo.get(guildId, userId),
        levelingActivityEventRepo.getUserEvents(guildId, userId, { since }),
        levelingActivityEventRepo.getUserActivityTotals(guildId, userId),
    ]);

    const recentActivity = aggregateActivityTotals(recentEvents);
    const dailyActivity = fillActivityDateRange(aggregateEventsByDate(recentEvents), startDate, endDate);

    const profile = buildUserLevelProfile({
        userId,
        progress,
        recentActivity,
        totalActivity,
    });

    const metrics = buildStatsCardMetrics({
        progress,
        recentActivity,
        totalActivity,
        recentEvents,
        dailyActivity,
    });

    return {
        profile,
        progress,
        dailyActivity,
        metrics,
    };
}
