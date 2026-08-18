import { describe, expect, it } from 'vitest';
import type { LevelingProgress } from '../data/levelingProgressSchema';
import {
    buildUserLevelProfile,
    formatActivityTotalsLine,
    formatXpProgressBar,
    getRecentActivitySince,
} from '../logic/userLevelProfile';
import type { LevelingActivityTotals } from '../data/levelingActivityEventSchema';

function emptyTotals(): LevelingActivityTotals {
    return {
        activityDate: 'total',
        messageCount: 0,
        reactionCount: 0,
        photoUploadCount: 0,
        voiceSessionCount: 0,
        totalXp: 0,
        eventCount: 0,
    };
}

function makeProgress(overrides: Partial<LevelingProgress> = {}): LevelingProgress {
    return {
        id: 1,
        guildId: 'guild-1',
        userId: 'user-1',
        totalXp: 0,
        level: 1,
        messageCount: 0,
        reactionCount: 0,
        photoUploadCount: 0,
        lastMessageXpAt: null,
        lastReactionXpAt: null,
        voiceSessionCount: 0,
        totalVoiceSeconds: 0,
        lastVoiceXpAt: null,
        createdAt: new Date('2026-05-01T00:00:00Z'),
        updatedAt: new Date('2026-05-01T00:00:00Z'),
        ...overrides,
    };
}

describe('userLevelProfile', () => {
    it('builds a profile from progress and activity totals', () => {
        const profile = buildUserLevelProfile({
            userId: 'user-1',
            progress: makeProgress({ totalXp: 355, level: 2 }),
            recentActivity: {
                activityDate: 'total',
                messageCount: 12,
                reactionCount: 4,
                photoUploadCount: 2,
                voiceSessionCount: 0,
                totalXp: 180,
                eventCount: 16,
            },
            totalActivity: {
                activityDate: 'total',
                messageCount: 40,
                reactionCount: 10,
                photoUploadCount: 5,
                voiceSessionCount: 0,
                totalXp: 355,
                eventCount: 50,
            },
        });

        expect(profile.level).toBe(2);
        expect(profile.totalXp).toBe(355);
        expect(profile.xpToNextLevel).toBe(20);
        expect(profile.recentActivity.messageCount).toBe(12);
        expect(profile.totalActivity.eventCount).toBe(50);
        expect(profile.hasAnyActivity).toBe(true);
    });

    it('defaults to level 1 with no activity when no progress exists', () => {
        const profile = buildUserLevelProfile({
            userId: 'user-1',
            progress: null,
            recentActivity: emptyTotals(),
            totalActivity: emptyTotals(),
        });

        expect(profile.level).toBe(1);
        expect(profile.totalXp).toBe(0);
        expect(profile.hasAnyActivity).toBe(false);
    });

    it('formats an XP progress bar', () => {
        expect(formatXpProgressBar(110, 155, 10)).toBe('[███████░░░] 110/155 XP');
    });

    it('formats activity totals for embed fields', () => {
        const line = formatActivityTotalsLine({
            activityDate: 'total',
            messageCount: 12,
            reactionCount: 4,
            photoUploadCount: 2,
            voiceSessionCount: 0,
            totalXp: 180,
            eventCount: 16,
        });

        expect(line).toContain('Messages: **12**');
        expect(line).toContain('Reactions: **4**');
        expect(line).toContain('Photo uploads: **2**');
        expect(line).toContain('Voice sessions: **0**');
        expect(line).toContain('XP earned: **180**');
    });

    it('computes the recent activity cutoff from the configured window', () => {
        const now = new Date('2026-05-26T12:00:00Z');
        expect(getRecentActivitySince(now).toISOString()).toBe('2026-05-19T12:00:00.000Z');
    });
});
