import { LEVELING_RECENT_ACTIVITY_DAYS } from '../../constants';
import type { DailyActivityBucket } from '../../data/levelingActivityEventSchema';
import type { LevelingProgress } from '../../data/levelingProgressSchema';
import type { LevelingActivityTotals } from '../../data/levelingActivityEventSchema';
import type { LevelingActivityEvent } from '../../data/levelingActivityEventSchema';

export type ActivityStatus = 'active' | 'quiet' | 'dormant' | 'none';

export type StatsCardMetrics = {
    activityStatus: ActivityStatus;
    lastActiveAt: Date | null;
    memberSince: Date | null;
    tenureDays: number;
    recentMsgsPerDay: number;
    recentXpPerDay: number;
    allTimeMsgsPerDay: number;
    messageSharePercent: number;
    reactionSharePercent: number;
    photoRatePercent: number;
    avgMessageLengthRecent: number | null;
    avgXpPerMessageRecent: number | null;
    dailyPeakEvents: number;
};

export type BuildStatsCardMetricsInput = {
    progress: LevelingProgress | null;
    recentActivity: LevelingActivityTotals;
    totalActivity: LevelingActivityTotals;
    recentEvents: ReadonlyArray<LevelingActivityEvent>;
    chartBuckets: ReadonlyArray<DailyActivityBucket>;
    recentPeriodDays?: number;
    now?: Date;
};

export function buildStatsCardMetrics(input: BuildStatsCardMetricsInput): StatsCardMetrics {
    const recentPeriodDays = input.recentPeriodDays ?? LEVELING_RECENT_ACTIVITY_DAYS;
    const { recentActivity, totalActivity, chartBuckets, recentEvents, progress } = input;

    const tenureDays = Math.max(1, computeTenureDays(progress, input.now ?? new Date()));
    const engagementTotal = recentActivity.messageCount + recentActivity.reactionCount;
    const messageSharePercent =
        engagementTotal > 0 ? Math.round((recentActivity.messageCount / engagementTotal) * 100) : 0;
    const reactionSharePercent = engagementTotal > 0 ? 100 - messageSharePercent : 0;
    const photoRatePercent =
        recentActivity.messageCount > 0
            ? Math.round((recentActivity.photoUploadCount / recentActivity.messageCount) * 100)
            : 0;

    const dailyPeakEvents = chartBuckets.reduce(
        (peak, day) => Math.max(peak, day.messageCount + day.reactionCount),
        0
    );

    return {
        activityStatus: resolveActivityStatus(recentActivity, totalActivity, recentPeriodDays),
        lastActiveAt: getLastActiveAt(progress),
        memberSince: progress?.createdAt ? toDate(progress.createdAt) : null,
        tenureDays,
        recentMsgsPerDay: roundOneDecimal(recentActivity.messageCount / recentPeriodDays),
        recentXpPerDay: roundOneDecimal(recentActivity.totalXp / recentPeriodDays),
        allTimeMsgsPerDay: roundOneDecimal(totalActivity.messageCount / tenureDays),
        messageSharePercent,
        reactionSharePercent,
        photoRatePercent,
        avgMessageLengthRecent: computeAvgMessageLength(recentEvents),
        avgXpPerMessageRecent:
            recentActivity.messageCount > 0
                ? roundOneDecimal(recentActivity.totalXp / recentActivity.messageCount)
                : null,
        dailyPeakEvents,
    };
}

export function formatRelativeTime(from: Date, now: Date = new Date()): string {
    const diffMs = now.getTime() - from.getTime();
    if (diffMs < 0) {
        return 'just now';
    }

    const minutes = Math.floor(diffMs / 60_000);
    if (minutes < 1) {
        return 'just now';
    }
    if (minutes < 60) {
        return `${minutes}m ago`;
    }

    const hours = Math.floor(minutes / 60);
    if (hours < 24) {
        return `${hours}h ago`;
    }

    const days = Math.floor(hours / 24);
    if (days < 14) {
        return `${days}d ago`;
    }

    return formatShortDate(from);
}

export function formatShortDate(date: Date): string {
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

export function formatActivityStatus(status: ActivityStatus): string {
    switch (status) {
        case 'active':
            return 'Active';
        case 'quiet':
            return 'Quiet';
        case 'dormant':
            return 'Dormant';
        case 'none':
            return 'No activity';
    }
}

function resolveActivityStatus(
    recentActivity: LevelingActivityTotals,
    totalActivity: LevelingActivityTotals,
    recentPeriodDays: number
): ActivityStatus {
    if (totalActivity.eventCount === 0) {
        return 'none';
    }

    if (recentActivity.eventCount === 0) {
        return 'dormant';
    }

    const periodScale = recentPeriodDays / LEVELING_RECENT_ACTIVITY_DAYS;
    const activeMessageThreshold = Math.max(1, Math.round(5 * periodScale));
    const activeEventThreshold = Math.max(1, Math.round(12 * periodScale));

    if (recentActivity.messageCount >= activeMessageThreshold || recentActivity.eventCount >= activeEventThreshold) {
        return 'active';
    }

    return 'quiet';
}

function getLastActiveAt(progress: LevelingProgress | null): Date | null {
    if (!progress) {
        return null;
    }

    const timestamps = [progress.lastMessageXpAt, progress.lastReactionXpAt]
        .filter((value): value is Date | string => value != null)
        .map((value) => toDate(value));

    if (timestamps.length === 0) {
        return null;
    }

    return new Date(Math.max(...timestamps.map((date) => date.getTime())));
}

function computeTenureDays(progress: LevelingProgress | null, now: Date): number {
    if (!progress?.createdAt) {
        return 1;
    }

    const createdAt = toDate(progress.createdAt);
    const diffMs = now.getTime() - createdAt.getTime();
    return Math.max(1, Math.ceil(diffMs / 86_400_000));
}

function computeAvgMessageLength(events: ReadonlyArray<LevelingActivityEvent>): number | null {
    const messageEvents = events.filter(
        (event) => event.activityType === 'message' && event.messageLength != null
    );

    if (messageEvents.length === 0) {
        return null;
    }

    const totalLength = messageEvents.reduce((sum, event) => sum + event.messageLength!, 0);
    return Math.round(totalLength / messageEvents.length);
}

function roundOneDecimal(value: number): number {
    return Math.round(value * 10) / 10;
}

function toDate(value: Date | string): Date {
    return value instanceof Date ? value : new Date(value);
}
