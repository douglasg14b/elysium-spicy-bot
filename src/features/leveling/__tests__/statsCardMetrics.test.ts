import { describe, expect, it } from 'vitest';
import type { LevelingActivityEvent } from '../data/levelingActivityEventSchema';
import type { LevelingActivityTotals } from '../data/levelingActivityEventSchema';
import type { LevelingProgress } from '../data/levelingProgressSchema';
import {
    buildStatsCardMetrics,
    formatActivityStatus,
    formatRelativeTime,
} from '../cards/statsCard/statsCardMetrics';

function makeTotals(overrides: Partial<LevelingActivityTotals> = {}): LevelingActivityTotals {
    return {
        activityDate: 'total',
        messageCount: 0,
        reactionCount: 0,
        photoUploadCount: 0,
        voiceSessionCount: 0,
        totalXp: 0,
        eventCount: 0,
        ...overrides,
    };
}

function makeProgress(overrides: Partial<LevelingProgress> = {}): LevelingProgress {
    return {
        id: 1,
        guildId: 'guild-1',
        userId: 'user-1',
        totalXp: 1000,
        level: 5,
        messageCount: 50,
        reactionCount: 20,
        photoUploadCount: 3,
        lastMessageXpAt: new Date('2026-05-26T10:00:00Z'),
        lastReactionXpAt: new Date('2026-05-25T18:00:00Z'),
        voiceSessionCount: 0,
        totalVoiceSeconds: 0,
        lastVoiceXpAt: null,
        createdAt: new Date('2026-05-01T00:00:00Z'),
        updatedAt: new Date('2026-05-26T10:00:00Z'),
        ...overrides,
    };
}

function makeMessageEvent(occurredAt: string, messageLength: number): LevelingActivityEvent {
    return {
        id: 1,
        guildId: 'guild-1',
        userId: 'user-1',
        activityType: 'message',
        xpAmount: 15,
        messageLength,
        photoBonus: false,
        voiceEligibleSeconds: null,
        voiceSessionStartedAt: null,
        voiceSessionEndedAt: null,
        voiceChannelId: null,
        voiceEligibilityRule: null,
        occurredAt: new Date(occurredAt),
    };
}

describe('statsCardMetrics', () => {
    it('marks members with recent volume as active', () => {
        const metrics = buildStatsCardMetrics({
            progress: makeProgress(),
            recentActivity: makeTotals({ messageCount: 8, reactionCount: 4, eventCount: 12 }),
            totalActivity: makeTotals({ messageCount: 50, eventCount: 80 }),
            recentEvents: [],
            chartBuckets: [],
        });

        expect(metrics.activityStatus).toBe('active');
    });

    it('marks members with no recent events as dormant', () => {
        const metrics = buildStatsCardMetrics({
            progress: makeProgress(),
            recentActivity: makeTotals(),
            totalActivity: makeTotals({ messageCount: 50, eventCount: 80 }),
            recentEvents: [],
            chartBuckets: [],
        });

        expect(metrics.activityStatus).toBe('dormant');
    });

    it('computes engagement mix and message length from recent events', () => {
        const metrics = buildStatsCardMetrics({
            progress: makeProgress(),
            recentActivity: makeTotals({
                messageCount: 6,
                reactionCount: 4,
                photoUploadCount: 2,
                totalXp: 120,
                eventCount: 10,
            }),
            totalActivity: makeTotals({ messageCount: 50, eventCount: 80 }),
            recentEvents: [
                makeMessageEvent('2026-05-26T12:00:00Z', 40),
                makeMessageEvent('2026-05-26T13:00:00Z', 80),
            ],
            chartBuckets: [],
            recentPeriodDays: 7,
        });

        expect(metrics.messageSharePercent).toBe(60);
        expect(metrics.reactionSharePercent).toBe(40);
        expect(metrics.voiceSharePercent).toBe(0);
        expect(metrics.photoRatePercent).toBe(33);
        expect(metrics.avgMessageLengthRecent).toBe(60);
        expect(metrics.avgXpPerMessageRecent).toBe(20);
        expect(metrics.recentMsgsPerDay).toBe(0.9);
    });

    it('formats relative time and status labels', () => {
        const now = new Date('2026-05-26T12:00:00Z');

        expect(formatRelativeTime(new Date('2026-05-26T11:30:00Z'), now)).toBe('30m ago');
        expect(formatRelativeTime(new Date('2026-03-17T12:00:00Z'), now)).toBe('Mar 17');
        expect(formatRelativeTime(new Date('2026-03-17T12:00:00Z'), now, { alwaysRelative: true })).toBe('70d ago');
        expect(formatActivityStatus('quiet')).toBe('Quiet');
    });

    it('scales active thresholds with the selected period length', () => {
        const quietMonth = buildStatsCardMetrics({
            progress: makeProgress(),
            recentActivity: makeTotals({ messageCount: 15, eventCount: 40 }),
            totalActivity: makeTotals({ messageCount: 50, eventCount: 80 }),
            recentEvents: [],
            chartBuckets: [],
            recentPeriodDays: 30,
        });
        const activeMonth = buildStatsCardMetrics({
            progress: makeProgress(),
            recentActivity: makeTotals({ messageCount: 22, eventCount: 40 }),
            totalActivity: makeTotals({ messageCount: 50, eventCount: 80 }),
            recentEvents: [],
            chartBuckets: [],
            recentPeriodDays: 30,
        });

        expect(quietMonth.activityStatus).toBe('quiet');
        expect(activeMonth.activityStatus).toBe('active');
    });
});
