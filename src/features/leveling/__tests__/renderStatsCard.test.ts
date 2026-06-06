import { describe, expect, it, vi } from 'vitest';
import type { DailyActivityBucket } from '../data/levelingActivityEventSchema';
import type { LevelingActivityTotals } from '../data/levelingActivityEventSchema';
import { renderStatsCard } from '../cards/statsCard/renderStatsCard';
import { buildStatsCardMetrics } from '../cards/statsCard/statsCardMetrics';
import { buildUserLevelProfile } from '../logic/userLevelProfile';

const WEBP_HEADER = Buffer.from([
    0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
]);

function makeStatsCardInput() {
    const recentActivity: LevelingActivityTotals = {
        activityDate: 'total',
        messageCount: 18,
        reactionCount: 7,
        photoUploadCount: 2,
        totalXp: 320,
        eventCount: 27,
    };
    const totalActivity: LevelingActivityTotals = {
        activityDate: 'total',
        messageCount: 120,
        reactionCount: 45,
        photoUploadCount: 6,
        totalXp: 2140,
        eventCount: 171,
    };
    const dailyActivity: DailyActivityBucket[] = [
        { activityDate: '2026-05-26', messageCount: 2, reactionCount: 0, photoUploadCount: 0 },
    ];
    const profile = buildUserLevelProfile({
        userId: 'user-1',
        progress: null,
        recentActivity,
        totalActivity,
    });
    const metrics = buildStatsCardMetrics({
        progress: null,
        recentActivity,
        totalActivity,
        recentEvents: [],
        chartBuckets: dailyActivity,
    });

    return {
        profile,
        progress: null,
        activityChart: { buckets: dailyActivity, granularity: 'daily' as const },
        statsPeriod: 'week' as const,
        metrics,
        displayName: 'Spicy Member',
    };
}

describe('renderStatsCard', () => {
    it('does not crash when the avatar CDN returns WebP bytes (Satori rejects WebP data URIs)', async () => {
        const realFetch = globalThis.fetch;
        const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
            const href = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;

            if (href.includes('discordapp.com')) {
                return {
                    ok: true,
                    headers: new Headers({ 'content-type': 'image/webp' }),
                    arrayBuffer: async () =>
                        WEBP_HEADER.buffer.slice(
                            WEBP_HEADER.byteOffset,
                            WEBP_HEADER.byteOffset + WEBP_HEADER.byteLength
                        ),
                } as Response;
            }

            return realFetch(url, init);
        });

        const png = await renderStatsCard({
            ...makeStatsCardInput(),
            avatarUrl: 'https://cdn.discordapp.com/avatars/1/abc.webp?size=256',
            fetchImpl,
        });

        expect(png.byteLength).toBeGreaterThan(1_000);
        expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    }, 30_000);
});
