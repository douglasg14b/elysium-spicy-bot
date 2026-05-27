import { describe, expect, it } from 'vitest';
import type { DailyActivityBucket } from '../data/levelingActivityEventSchema';
import type { LevelingActivityTotals } from '../data/levelingActivityEventSchema';
import { buildStatsCardElement } from '../cards/statsCard/buildStatsCardElement';
import { buildStatsCardMetrics } from '../cards/statsCard/statsCardMetrics';
import { buildUserLevelProfile } from '../logic/userLevelProfile';

function makeTotals(overrides: Partial<LevelingActivityTotals> = {}): LevelingActivityTotals {
    return {
        activityDate: 'total',
        messageCount: 0,
        reactionCount: 0,
        photoUploadCount: 0,
        totalXp: 0,
        eventCount: 0,
        ...overrides,
    };
}

function makeDailyActivity(): DailyActivityBucket[] {
    return [
        { activityDate: '2026-05-20', messageCount: 2, reactionCount: 1, photoUploadCount: 0 },
        { activityDate: '2026-05-21', messageCount: 0, reactionCount: 0, photoUploadCount: 0 },
        { activityDate: '2026-05-22', messageCount: 4, reactionCount: 2, photoUploadCount: 1 },
        { activityDate: '2026-05-23', messageCount: 3, reactionCount: 1, photoUploadCount: 0 },
        { activityDate: '2026-05-24', messageCount: 5, reactionCount: 0, photoUploadCount: 1 },
        { activityDate: '2026-05-25', messageCount: 2, reactionCount: 3, photoUploadCount: 0 },
        { activityDate: '2026-05-26', messageCount: 2, reactionCount: 0, photoUploadCount: 0 },
    ];
}

describe('buildStatsCardElement', () => {
    it('renders moderator-focused sections when the member has activity', () => {
        const recentActivity = makeTotals({
            messageCount: 18,
            reactionCount: 7,
            photoUploadCount: 2,
            totalXp: 320,
            eventCount: 27,
        });
        const totalActivity = makeTotals({
            messageCount: 120,
            reactionCount: 45,
            photoUploadCount: 6,
            totalXp: 2140,
            eventCount: 171,
        });
        const dailyActivity = makeDailyActivity();
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
            dailyActivity,
        });

        const element = buildStatsCardElement({
            profile,
            progress: null,
            dailyActivity,
            metrics,
            displayName: 'Spicy Member',
            avatarDataUri: null,
            now: new Date('2026-05-26T12:00:00Z'),
        });

        const serialized = JSON.stringify(element);

        expect(serialized).toContain('Spicy Member');
        expect(serialized).toContain('Activity trend (7d)');
        expect(serialized).toContain('Engagement mix');
        expect(serialized).toContain('Active');
    });

    it('shows an empty-state message when there is no activity', () => {
        const profile = buildUserLevelProfile({
            userId: 'user-1',
            progress: null,
            recentActivity: makeTotals(),
            totalActivity: makeTotals(),
        });

        const metrics = buildStatsCardMetrics({
            progress: null,
            recentActivity: makeTotals(),
            totalActivity: makeTotals(),
            recentEvents: [],
            dailyActivity: [],
        });

        const element = buildStatsCardElement({
            profile,
            progress: null,
            dailyActivity: [],
            metrics,
            displayName: 'Quiet Member',
            avatarDataUri: null,
        });

        expect(JSON.stringify(element)).toContain('No tracked activity yet');
    });
});
