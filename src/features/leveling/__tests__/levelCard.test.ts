import { describe, expect, it } from 'vitest';
import type { LevelingActivityTotals } from '../data/levelingActivityEventSchema';
import type { LevelingProgress } from '../data/levelingProgressSchema';
import { buildLevelCardElement } from '../cards/levelCard/buildLevelCardElement';
import { getLevelCardProgressPercent, getLevelCardProgressRatio } from '../cards/levelCard/levelCardProgress';
import { buildUserLevelProfile } from '../logic/userLevelProfile';

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
        createdAt: new Date('2026-05-01T00:00:00Z'),
        updatedAt: new Date('2026-05-01T00:00:00Z'),
        ...overrides,
    };
}

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

describe('levelCardProgress', () => {
    it('clamps progress ratio between 0 and 1', () => {
        expect(getLevelCardProgressRatio(50, 100)).toBe(0.5);
        expect(getLevelCardProgressRatio(150, 100)).toBe(1);
        expect(getLevelCardProgressRatio(-5, 100)).toBe(0);
        expect(getLevelCardProgressRatio(10, 0)).toBe(0);
    });

    it('returns whole-number progress percent for the bar width', () => {
        expect(getLevelCardProgressPercent(58, 100)).toBe(58);
        expect(getLevelCardProgressPercent(999, 100)).toBe(100);
    });
});

describe('buildLevelCardElement', () => {
    it('builds a card tree for active profiles', () => {
        const profile = buildUserLevelProfile({
            userId: 'user-1',
            progress: makeProgress({ totalXp: 420, level: 3 }),
            recentActivity: makeTotals({
                messageCount: 4,
                reactionCount: 2,
                photoUploadCount: 1,
                totalXp: 80,
                eventCount: 7,
            }),
            totalActivity: makeTotals({
                messageCount: 40,
                reactionCount: 12,
                photoUploadCount: 3,
                totalXp: 420,
                eventCount: 55,
            }),
        });

        const element = buildLevelCardElement({
            profile,
            displayName: 'Spicy Member',
            avatarDataUri: null,
        });

        expect(element.type).toBe('div');
        expect(JSON.stringify(element)).toContain('Spicy Member');
        expect(JSON.stringify(element)).toContain('"LVL"');
    });
});
