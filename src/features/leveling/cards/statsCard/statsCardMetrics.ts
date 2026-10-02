import { LEVELING_RECENT_ACTIVITY_DAYS } from '../../constants';
import type { DailyActivityBucket } from '../../data/levelingXpGrantSchema';
import type { LevelingProgress } from '../../data/levelingProgressSchema';
import type { LevelingActivityTotals } from '../../data/levelingXpGrantSchema';
import type { LevelingXpGrant } from '../../data/levelingXpGrantSchema';

export type ActivityStatus = 'active' | 'quiet' | 'dormant' | 'none';

/**
 * The statuses, as data, for the places that need to enumerate them.
 *
 * Added because this union now crosses the wire to the web UI, where the browser mirrors
 * it by hand. A closed vocabulary mirrored as a *type* alone drifts silently — the repo
 * has already been bitten by exactly that, with a browser filtering forever for a member
 * the server never emitted — so the members exist as an array a drift test can compare.
 */
export const ACTIVITY_STATUSES = [
    'active',
    'quiet',
    'dormant',
    'none',
] as const satisfies readonly ActivityStatus[];

/**
 * Do not delete as unused: removing this lets the list above go stale.
 *
 * `satisfies` rejects a member that is not an `ActivityStatus` but says nothing about one
 * the list *omits*, which is the direction that rots. The tuple wrapper is load-bearing —
 * a bare `extends never` distributes and is vacuously true for an empty union.
 */
type MissingActivityStatus = Exclude<ActivityStatus, (typeof ACTIVITY_STATUSES)[number]>;

const activityStatusesAreComplete: [MissingActivityStatus] extends [never]
    ? true
    : ['ACTIVITY_STATUSES is missing a member', MissingActivityStatus] = true;

void activityStatusesAreComplete;

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
    voiceSharePercent: number;
    photoRatePercent: number;
    avgMessageLengthRecent: number | null;
    avgXpPerMessageRecent: number | null;
    dailyPeakEvents: number;
};

export type BuildStatsCardMetricsInput = {
    progress: LevelingProgress | null;
    recentActivity: LevelingActivityTotals;
    totalActivity: LevelingActivityTotals;
    recentEvents: ReadonlyArray<LevelingXpGrant>;
    chartBuckets: ReadonlyArray<DailyActivityBucket>;
    recentPeriodDays?: number;
    now?: Date;
};

export function buildStatsCardMetrics(input: BuildStatsCardMetricsInput): StatsCardMetrics {
    const recentPeriodDays = input.recentPeriodDays ?? LEVELING_RECENT_ACTIVITY_DAYS;
    const { recentActivity, totalActivity, chartBuckets, recentEvents, progress } = input;

    const tenureDays = Math.max(1, computeTenureDays(progress, input.now ?? new Date()));
    const engagementTotal =
        recentActivity.messageCount + recentActivity.reactionCount + recentActivity.voiceSessionCount;
    const messageSharePercent =
        engagementTotal > 0 ? Math.round((recentActivity.messageCount / engagementTotal) * 100) : 0;
    const reactionSharePercent =
        engagementTotal > 0 ? Math.round((recentActivity.reactionCount / engagementTotal) * 100) : 0;
    const voiceSharePercent =
        engagementTotal > 0 ? Math.max(0, 100 - messageSharePercent - reactionSharePercent) : 0;
    const photoRatePercent =
        recentActivity.messageCount > 0
            ? Math.round((recentActivity.photoUploadCount / recentActivity.messageCount) * 100)
            : 0;

    const dailyPeakEvents = chartBuckets.reduce(
        (peak, day) => Math.max(peak, day.messageCount + day.reactionCount + day.voiceSessionCount),
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
        voiceSharePercent,
        photoRatePercent,
        avgMessageLengthRecent: computeAvgMessageLength(recentEvents),
        avgXpPerMessageRecent:
            recentActivity.messageCount > 0
                ? roundOneDecimal(recentActivity.totalXp / recentActivity.messageCount)
                : null,
        dailyPeakEvents,
    };
}

export function formatRelativeTime(
    from: Date,
    now: Date = new Date(),
    options?: { alwaysRelative?: boolean }
): string {
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
    if (options?.alwaysRelative || days < 14) {
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

    const timestamps: Date[] = [];
    for (const value of [progress.lastMessageXpAt, progress.lastReactionXpAt, progress.lastVoiceXpAt]) {
        if (value) {
            timestamps.push(toDate(value));
        }
    }

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

function computeAvgMessageLength(events: ReadonlyArray<LevelingXpGrant>): number | null {
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
