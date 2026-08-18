/**
 * Local stats card preview — edit PREVIEW_SCENARIO below, then run:
 *
 *   pnpm test statsCard.introspect
 *
 * Writes:
 *   `.jarvis/stats-card-preview.png` (last week)
 *   `.jarvis/stats-card-month-preview.png` (last month)
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { DailyActivityBucket } from '../data/levelingActivityEventSchema';
import type { LevelingActivityEvent } from '../data/levelingActivityEventSchema';
import type { LevelingActivityTotals } from '../data/levelingActivityEventSchema';
import type { LevelingProgress } from '../data/levelingProgressSchema';
import { renderStatsCard } from '../cards/statsCard/renderStatsCard';
import { buildStatsCardMetrics } from '../cards/statsCard/statsCardMetrics';
import {
    fillActivityDateRange,
    subtractActivityDays,
    sumDailyActivity,
} from '../logic/activityEventAggregation';
import { buildUserLevelProfile } from '../logic/userLevelProfile';
import { getStatsPeriodDays, resolveActivityChartGranularity, type StatsPeriod } from '../logic/statsPeriod';

const PREVIEW_DIR = join(process.cwd(), '.jarvis');
const WEEK_PREVIEW_OUTPUT = join(PREVIEW_DIR, 'stats-card-preview.png');
const MONTH_PREVIEW_OUTPUT = join(PREVIEW_DIR, 'stats-card-month-preview.png');

const PREVIEW_NOW = new Date('2026-05-26T12:00:00Z');

/** Edit this scenario to iterate on the stats card locally. */
const PREVIEW_SCENARIO = {
    displayName: 'Spicy Member',
    progress: {
        id: 1,
        guildId: 'preview-guild',
        userId: 'preview-user',
        totalXp: 2_140,
        level: 8,
        messageCount: 120,
        reactionCount: 45,
        photoUploadCount: 6,
        lastMessageXpAt: new Date('2026-05-26T09:15:00Z'),
        lastReactionXpAt: new Date('2026-05-25T22:40:00Z'),
        voiceSessionCount: 0,
        totalVoiceSeconds: 0,
        lastVoiceXpAt: null,
        createdAt: new Date('2026-04-01T00:00:00Z'),
        updatedAt: new Date('2026-05-26T09:15:00Z'),
    } satisfies LevelingProgress,
    recentActivity: {
        activityDate: 'total',
        messageCount: 18,
        reactionCount: 7,
        photoUploadCount: 2,
        voiceSessionCount: 0,
        totalXp: 320,
        eventCount: 27,
    } satisfies LevelingActivityTotals,
    totalActivity: {
        activityDate: 'total',
        messageCount: 120,
        reactionCount: 45,
        photoUploadCount: 6,
        voiceSessionCount: 0,
        totalXp: 2_140,
        eventCount: 171,
    } satisfies LevelingActivityTotals,
    dailyActivity: [
        { activityDate: '2026-05-20', messageCount: 2, reactionCount: 1, photoUploadCount: 0 , voiceSessionCount: 0 },
        { activityDate: '2026-05-21', messageCount: 0, reactionCount: 0, photoUploadCount: 0 , voiceSessionCount: 0 },
        { activityDate: '2026-05-22', messageCount: 4, reactionCount: 2, photoUploadCount: 1 , voiceSessionCount: 0 },
        { activityDate: '2026-05-23', messageCount: 3, reactionCount: 1, photoUploadCount: 0 , voiceSessionCount: 0 },
        { activityDate: '2026-05-24', messageCount: 5, reactionCount: 0, photoUploadCount: 1 , voiceSessionCount: 0 },
        { activityDate: '2026-05-25', messageCount: 2, reactionCount: 3, photoUploadCount: 0 , voiceSessionCount: 0 },
        { activityDate: '2026-05-26', messageCount: 2, reactionCount: 0, photoUploadCount: 0 , voiceSessionCount: 0 },
    ] satisfies DailyActivityBucket[],
    recentEvents: [
        {
            id: 1,
            guildId: 'preview-guild',
            userId: 'preview-user',
            activityType: 'message',
            xpAmount: 18,
            messageLength: 120,
            photoBonus: false,
            voiceEligibleSeconds: null,
            voiceSessionStartedAt: null,
            voiceSessionEndedAt: null,
            voiceChannelId: null,
            voiceEligibilityRule: null,
            occurredAt: new Date('2026-05-26T09:15:00Z'),
        },
        {
            id: 2,
            guildId: 'preview-guild',
            userId: 'preview-user',
            activityType: 'message',
            xpAmount: 22,
            messageLength: 240,
            photoBonus: true,
            voiceEligibleSeconds: null,
            voiceSessionStartedAt: null,
            voiceSessionEndedAt: null,
            voiceChannelId: null,
            voiceEligibilityRule: null,
            occurredAt: new Date('2026-05-25T14:00:00Z'),
        },
    ] satisfies LevelingActivityEvent[],
};

function formatUtcDateKey(date: Date): string {
    const year = date.getUTCFullYear();
    const month = String(date.getUTCMonth() + 1).padStart(2, '0');
    const day = String(date.getUTCDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

function getPreviewDateRange(now: Date, periodDays: number): { startDate: string; endDate: string } {
    const endDate = formatUtcDateKey(now);
    const startDate = formatUtcDateKey(subtractActivityDays(now, periodDays - 1));
    return { startDate, endDate };
}

function makeSyntheticDailyActivity(startDate: string, endDate: string): DailyActivityBucket[] {
    const sparseBuckets: DailyActivityBucket[] = [];

    for (const activityDate of iteratePreviewDates(startDate, endDate)) {
        const dayIndex = sparseBuckets.length;
        const weekend = dayIndex % 7 === 5 || dayIndex % 7 === 6;
        const wave = Math.sin(dayIndex * 0.55) * 2.5;
        const messageCount = Math.max(0, Math.round((weekend ? 1 : 4) + wave + (dayIndex % 4)));
        const reactionCount = Math.max(0, Math.round(messageCount * 0.45 + (dayIndex % 3)));
        const photoUploadCount = dayIndex % 9 === 0 ? 1 : 0;

        if (messageCount > 0 || reactionCount > 0 || photoUploadCount > 0) {
            sparseBuckets.push({
                activityDate,
                messageCount,
                reactionCount,
                photoUploadCount,
                voiceSessionCount: 0,
            });
        }
    }

    return fillActivityDateRange(sparseBuckets, startDate, endDate);
}

function* iteratePreviewDates(startDate: string, endDate: string): Generator<string> {
    const [startYear, startMonth, startDay] = startDate.split('-').map(Number);
    const [endYear, endMonth, endDay] = endDate.split('-').map(Number);
    const cursor = new Date(Date.UTC(startYear, startMonth - 1, startDay));
    const end = new Date(Date.UTC(endYear, endMonth - 1, endDay));

    while (cursor <= end) {
        yield formatUtcDateKey(cursor);
        cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
}

function bucketsToRecentActivity(buckets: DailyActivityBucket[]): LevelingActivityTotals {
    const summed = sumDailyActivity(buckets);
    const eventCount = summed.messageCount + summed.reactionCount;
    const totalXp = summed.messageCount * 16 + summed.reactionCount * 2 + summed.photoUploadCount * 12;

    return {
        activityDate: 'total',
        messageCount: summed.messageCount,
        reactionCount: summed.reactionCount,
        photoUploadCount: summed.photoUploadCount,
        voiceSessionCount: summed.voiceSessionCount,
        totalXp,
        eventCount,
    };
}

async function writeStatsCardPreview(
    outputPath: string,
    input: {
        displayName: string;
        progress: LevelingProgress;
        recentActivity: LevelingActivityTotals;
        totalActivity: LevelingActivityTotals;
        chartBuckets: DailyActivityBucket[];
        statsPeriod: StatsPeriod;
        recentEvents: LevelingActivityEvent[];
        now: Date;
    }
): Promise<Buffer> {
    const periodDays = getStatsPeriodDays(input.statsPeriod);
    const profile = buildUserLevelProfile({
        userId: input.progress.userId,
        progress: input.progress,
        recentActivity: input.recentActivity,
        totalActivity: input.totalActivity,
        recentPeriodDays: periodDays,
        now: input.now,
    });

    const metrics = buildStatsCardMetrics({
        progress: input.progress,
        recentActivity: input.recentActivity,
        totalActivity: input.totalActivity,
        recentEvents: input.recentEvents,
        chartBuckets: input.chartBuckets,
        recentPeriodDays: periodDays,
        now: input.now,
    });

    const png = await renderStatsCard({
        profile,
        progress: input.progress,
        activityChart: {
            buckets: input.chartBuckets,
            granularity: resolveActivityChartGranularity(periodDays),
        },
        statsPeriod: input.statsPeriod,
        metrics,
        displayName: input.displayName,
        avatarUrl: null,
    });

    await mkdir(PREVIEW_DIR, { recursive: true });
    await writeFile(outputPath, png);

    return png;
}

describe('stats card introspection', () => {
    it('writes a PNG preview for the last-week stats card', async () => {
        const png = await writeStatsCardPreview(WEEK_PREVIEW_OUTPUT, {
            displayName: PREVIEW_SCENARIO.displayName,
            progress: PREVIEW_SCENARIO.progress,
            recentActivity: PREVIEW_SCENARIO.recentActivity,
            totalActivity: PREVIEW_SCENARIO.totalActivity,
            chartBuckets: PREVIEW_SCENARIO.dailyActivity,
            statsPeriod: 'week',
            recentEvents: PREVIEW_SCENARIO.recentEvents,
            now: PREVIEW_NOW,
        });

        console.log(`\nWeek stats card preview written to:\n  ${WEEK_PREVIEW_OUTPUT}\n`);

        expect(png.byteLength).toBeGreaterThan(1_000);
        expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    }, 30_000);

    it('writes a PNG preview for the last-month stats card', async () => {
        const periodDays = getStatsPeriodDays('month');
        const { startDate, endDate } = getPreviewDateRange(PREVIEW_NOW, periodDays);
        const chartBuckets = makeSyntheticDailyActivity(startDate, endDate);
        const recentActivity = bucketsToRecentActivity(chartBuckets);

        const png = await writeStatsCardPreview(MONTH_PREVIEW_OUTPUT, {
            displayName: PREVIEW_SCENARIO.displayName,
            progress: PREVIEW_SCENARIO.progress,
            recentActivity,
            totalActivity: PREVIEW_SCENARIO.totalActivity,
            chartBuckets,
            statsPeriod: 'month',
            recentEvents: [
                {
                    id: 1,
                    guildId: 'preview-guild',
                    userId: 'preview-user',
                    activityType: 'message',
                    xpAmount: 18,
                    messageLength: 142,
                    photoBonus: false,
                    voiceEligibleSeconds: null,
                    voiceSessionStartedAt: null,
                    voiceSessionEndedAt: null,
                    voiceChannelId: null,
                    voiceEligibilityRule: null,
                    occurredAt: new Date('2026-05-26T09:15:00Z'),
                },
                {
                    id: 2,
                    guildId: 'preview-guild',
                    userId: 'preview-user',
                    activityType: 'message',
                    xpAmount: 22,
                    messageLength: 228,
                    photoBonus: true,
                    voiceEligibleSeconds: null,
                    voiceSessionStartedAt: null,
                    voiceSessionEndedAt: null,
                    voiceChannelId: null,
                    voiceEligibilityRule: null,
                    occurredAt: new Date('2026-05-18T14:00:00Z'),
                },
                {
                    id: 3,
                    guildId: 'preview-guild',
                    userId: 'preview-user',
                    activityType: 'message',
                    xpAmount: 15,
                    messageLength: 96,
                    photoBonus: false,
                    voiceEligibleSeconds: null,
                    voiceSessionStartedAt: null,
                    voiceSessionEndedAt: null,
                    voiceChannelId: null,
                    voiceEligibilityRule: null,
                    occurredAt: new Date('2026-05-04T11:30:00Z'),
                },
            ],
            now: PREVIEW_NOW,
        });

        console.log(`\nMonth stats card preview written to:\n  ${MONTH_PREVIEW_OUTPUT}\n`);

        expect(chartBuckets).toHaveLength(30);
        expect(png.byteLength).toBeGreaterThan(1_000);
        expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    }, 30_000);
});
