import { LEVELING_RECENT_ACTIVITY_DAYS } from '../constants';
import type { LevelingActivityTotals } from '../data/levelingActivityEventSchema';
import type { LevelingProgress } from '../data/levelingProgressSchema';
import { subtractActivityDays } from './activityEventAggregation';
import {
    getLevelFromTotalXp,
    getXpProgressWithinLevel,
    getXpThresholdForLevel,
    getXpToNextLevel,
} from './xpCalculator';

export type UserLevelProfile = {
    userId: string;
    level: number;
    totalXp: number;
    xpWithinLevel: number;
    xpToNextLevel: number;
    xpForCurrentLevelStep: number;
    recentActivity: LevelingActivityTotals;
    totalActivity: LevelingActivityTotals;
    recentPeriodDays: number;
    hasAnyActivity: boolean;
};

export type BuildUserLevelProfileInput = {
    userId: string;
    progress: LevelingProgress | null;
    recentActivity: LevelingActivityTotals;
    totalActivity: LevelingActivityTotals;
    recentPeriodDays?: number;
    now?: Date;
};

export function getRecentActivitySince(now: Date = new Date()): Date {
    return subtractActivityDays(now, LEVELING_RECENT_ACTIVITY_DAYS);
}

export function buildUserLevelProfile(input: BuildUserLevelProfileInput): UserLevelProfile {
    const totalXp = input.progress?.totalXp ?? 0;
    const level = input.progress?.level ?? getLevelFromTotalXp(totalXp);
    const xpForCurrentLevelStep = getXpThresholdForLevel(level);
    const xpWithinLevel = getXpProgressWithinLevel(totalXp, level);
    const xpToNextLevel = getXpToNextLevel(totalXp);
    const recentPeriodDays = input.recentPeriodDays ?? LEVELING_RECENT_ACTIVITY_DAYS;

    return {
        userId: input.userId,
        level,
        totalXp,
        xpWithinLevel,
        xpToNextLevel,
        xpForCurrentLevelStep,
        recentActivity: input.recentActivity,
        totalActivity: input.totalActivity,
        recentPeriodDays,
        hasAnyActivity: input.totalActivity.eventCount > 0,
    };
}

export function formatXpProgressBar(
    xpWithinLevel: number,
    xpForCurrentLevelStep: number,
    barLength: number = 12
): string {
    const ratio = xpForCurrentLevelStep > 0 ? Math.min(xpWithinLevel / xpForCurrentLevelStep, 1) : 0;
    const filled = Math.round(ratio * barLength);
    const empty = barLength - filled;

    return `[${'█'.repeat(filled)}${'░'.repeat(empty)}] ${xpWithinLevel.toLocaleString()}/${xpForCurrentLevelStep.toLocaleString()} XP`;
}

export function formatActivityTotalsLine(totals: LevelingActivityTotals): string {
    return [
        `💬 Messages: **${totals.messageCount.toLocaleString()}**`,
        `👍 Reactions: **${totals.reactionCount.toLocaleString()}**`,
        `📷 Photo uploads: **${totals.photoUploadCount.toLocaleString()}**`,
        `✨ XP earned: **${totals.totalXp.toLocaleString()}**`,
    ].join('\n');
}
