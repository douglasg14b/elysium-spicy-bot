/**
 * Local stats card preview — edit PREVIEW_SCENARIO below, then run:
 *
 *   pnpm test statsCard.introspect
 *
 * Writes `.jarvis/stats-card-preview.png` (open in your image viewer).
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
import { buildUserLevelProfile } from '../logic/userLevelProfile';

const PREVIEW_OUTPUT = join(process.cwd(), '.jarvis', 'stats-card-preview.png');

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
        createdAt: new Date('2026-04-01T00:00:00Z'),
        updatedAt: new Date('2026-05-26T09:15:00Z'),
    } satisfies LevelingProgress,
    recentActivity: {
        activityDate: 'total',
        messageCount: 18,
        reactionCount: 7,
        photoUploadCount: 2,
        totalXp: 320,
        eventCount: 27,
    } satisfies LevelingActivityTotals,
    totalActivity: {
        activityDate: 'total',
        messageCount: 120,
        reactionCount: 45,
        photoUploadCount: 6,
        totalXp: 2_140,
        eventCount: 171,
    } satisfies LevelingActivityTotals,
    dailyActivity: [
        { activityDate: '2026-05-20', messageCount: 2, reactionCount: 1, photoUploadCount: 0 },
        { activityDate: '2026-05-21', messageCount: 0, reactionCount: 0, photoUploadCount: 0 },
        { activityDate: '2026-05-22', messageCount: 4, reactionCount: 2, photoUploadCount: 1 },
        { activityDate: '2026-05-23', messageCount: 3, reactionCount: 1, photoUploadCount: 0 },
        { activityDate: '2026-05-24', messageCount: 5, reactionCount: 0, photoUploadCount: 1 },
        { activityDate: '2026-05-25', messageCount: 2, reactionCount: 3, photoUploadCount: 0 },
        { activityDate: '2026-05-26', messageCount: 2, reactionCount: 0, photoUploadCount: 0 },
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
            occurredAt: new Date('2026-05-25T14:00:00Z'),
        },
    ] satisfies LevelingActivityEvent[],
};

describe('stats card introspection', () => {
    it('writes a PNG preview for local stats card tuning', async () => {
        const profile = buildUserLevelProfile({
            userId: PREVIEW_SCENARIO.progress.userId,
            progress: PREVIEW_SCENARIO.progress,
            recentActivity: PREVIEW_SCENARIO.recentActivity,
            totalActivity: PREVIEW_SCENARIO.totalActivity,
        });

        const metrics = buildStatsCardMetrics({
            progress: PREVIEW_SCENARIO.progress,
            recentActivity: PREVIEW_SCENARIO.recentActivity,
            totalActivity: PREVIEW_SCENARIO.totalActivity,
            recentEvents: PREVIEW_SCENARIO.recentEvents,
            dailyActivity: PREVIEW_SCENARIO.dailyActivity,
            now: new Date('2026-05-26T12:00:00Z'),
        });

        const png = await renderStatsCard({
            profile,
            progress: PREVIEW_SCENARIO.progress,
            dailyActivity: PREVIEW_SCENARIO.dailyActivity,
            metrics,
            displayName: PREVIEW_SCENARIO.displayName,
            avatarUrl: null,
        });

        await mkdir(join(process.cwd(), '.jarvis'), { recursive: true });
        await writeFile(PREVIEW_OUTPUT, png);

        console.log(`\nStats card preview written to:\n  ${PREVIEW_OUTPUT}\n`);

        expect(png.byteLength).toBeGreaterThan(1_000);
        expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    }, 30_000);
});
