import { describe, expect, it } from 'vitest';
import type { LevelingProgress } from '../data/levelingProgressSchema';
import {
    buildBelowThresholdReport,
    formatBelowThresholdCsv,
    formatBelowThresholdReply,
    formatThresholdLabel,
    getXpToThreshold,
    isBelowThreshold,
    parseBelowThresholdFilter,
    type GuildMemberSnapshot,
} from '../logic/belowThresholdReport';
import { getTotalXpForLevel } from '../logic/xpCalculator';

function makeMember(
    userId: string,
    overrides: Partial<GuildMemberSnapshot> = {}
): GuildMemberSnapshot {
    return {
        userId,
        displayName: overrides.displayName ?? `Member ${userId}`,
        username: overrides.username ?? `user_${userId}`,
        isBot: overrides.isBot ?? false,
        avatarUrl: overrides.avatarUrl ?? null,
    };
}

function makeProgress(
    userId: string,
    overrides: Partial<Pick<LevelingProgress, 'totalXp' | 'level' | 'messageCount' | 'reactionCount' | 'photoUploadCount'>> & {
        lastMessageXpAt?: Date | null;
    } = {}
): LevelingProgress {
    return {
        id: 1,
        guildId: 'guild-1',
        userId,
        totalXp: overrides.totalXp ?? 0,
        level: overrides.level ?? 1,
        messageCount: overrides.messageCount ?? 0,
        reactionCount: overrides.reactionCount ?? 0,
        photoUploadCount: overrides.photoUploadCount ?? 0,
        lastMessageXpAt: overrides.lastMessageXpAt ?? null,
        lastReactionXpAt: null,
        voiceSessionCount: 0,
        totalVoiceSeconds: 0,
        lastVoiceXpAt: null,
        createdAt: new Date('2026-05-01T00:00:00Z'),
        updatedAt: new Date('2026-05-01T00:00:00Z'),
    };
}

describe('parseBelowThresholdFilter', () => {
    it('requires a level or XP bar', () => {
        expect(parseBelowThresholdFilter({ level: null, xp: null, scope: null })).toEqual({
            ok: false,
            message: 'Pick a level, an XP amount, or both.',
        });
    });

    it('defaults scope to current members', () => {
        expect(parseBelowThresholdFilter({ level: 10, xp: null, scope: null })).toEqual({
            ok: true,
            filter: { level: 10, xp: null, scope: 'current' },
        });
    });
});

describe('isBelowThreshold', () => {
    it('treats unset bars as inactive and ANDs bars that are set', () => {
        expect(isBelowThreshold(8, 4000, { level: 10, xp: null })).toBe(true);
        expect(isBelowThreshold(10, 4000, { level: 10, xp: null })).toBe(false);
        expect(isBelowThreshold(8, 5000, { level: null, xp: 5000 })).toBe(false);
        expect(isBelowThreshold(8, 4000, { level: 10, xp: 5000 })).toBe(true);
        expect(isBelowThreshold(12, 4000, { level: 10, xp: 5000 })).toBe(false);
    });
});

describe('getXpToThreshold', () => {
    it('uses the larger remainder when both bars are set', () => {
        const levelTenXp = getTotalXpForLevel(10);
        expect(getXpToThreshold(100, { level: 10, xp: null })).toBe(levelTenXp - 100);
        expect(getXpToThreshold(100, { level: null, xp: 500 })).toBe(400);
        expect(getXpToThreshold(100, { level: 10, xp: 500 })).toBe(Math.max(levelTenXp - 100, 400));
    });
});

describe('buildBelowThresholdReport', () => {
    it('includes untracked current members as level 1 / 0 XP', () => {
        const report = buildBelowThresholdReport({
            filter: { level: 10, xp: null, scope: 'current' },
            members: [makeMember('lurker'), makeMember('climber'), makeMember('done')],
            progressRows: [
                makeProgress('climber', { totalXp: 400, level: 3, messageCount: 12 }),
                makeProgress('done', { totalXp: getTotalXpForLevel(10), level: 10, messageCount: 80 }),
            ],
        });

        expect(report.totalConsidered).toBe(3);
        expect(report.entries.map((entry) => entry.userId)).toEqual(['climber', 'lurker']);
        expect(report.entries[1]).toEqual(
            expect.objectContaining({
                userId: 'lurker',
                totalXp: 0,
                level: 1,
                tracked: false,
            })
        );
    });

    it('omits untracked members when scope is tracked', () => {
        const report = buildBelowThresholdReport({
            filter: { level: 10, xp: null, scope: 'tracked' },
            members: [makeMember('lurker'), makeMember('climber')],
            progressRows: [makeProgress('climber', { totalXp: 400, level: 3 })],
        });

        expect(report.totalConsidered).toBe(1);
        expect(report.entries.map((entry) => entry.userId)).toEqual(['climber']);
    });

    it('skips bots and sorts closest to the bar first', () => {
        const report = buildBelowThresholdReport({
            filter: { level: null, xp: 1000, scope: 'current' },
            members: [
                makeMember('bot', { isBot: true, displayName: 'Bot' }),
                makeMember('far', { displayName: 'Far' }),
                makeMember('close', { displayName: 'Close' }),
            ],
            progressRows: [
                makeProgress('far', { totalXp: 100, level: 2 }),
                makeProgress('close', { totalXp: 900, level: 5 }),
                makeProgress('bot', { totalXp: 50, level: 1 }),
            ],
        });

        expect(report.entries.map((entry) => entry.userId)).toEqual(['close', 'far']);
        expect(report.entries[0]?.xpToThreshold).toBe(100);
        expect(report.cardEntries).toHaveLength(2);
    });
});

describe('formatBelowThresholdCsv', () => {
    it('quotes display names that contain commas', () => {
        const report = buildBelowThresholdReport({
            filter: { level: 5, xp: null, scope: 'current' },
            members: [makeMember('user-1', { displayName: 'Last, First', username: 'spicy' })],
            progressRows: [makeProgress('user-1', { totalXp: 10, level: 1, messageCount: 2 })],
        });

        const csv = formatBelowThresholdCsv(report);
        expect(csv.split('\n')[0]).toBe(
            'userId,displayName,username,level,totalXp,xpToThreshold,messageCount,reactionCount,photoUploadCount,lastActiveAt,tracked'
        );
        expect(csv).toContain('"Last, First"');
        expect(csv).toContain('spicy');
    });
});

describe('formatBelowThresholdReply', () => {
    it('mentions the CSV when the card cannot show everyone', () => {
        const members = Array.from({ length: 12 }, (_, index) =>
            makeMember(`user-${index}`, { displayName: `Member ${index}` })
        );
        const report = buildBelowThresholdReport({
            filter: { level: 10, xp: null, scope: 'current' },
            members,
            progressRows: [],
        });

        expect(formatThresholdLabel(report.filter)).toBe('below level 10');
        expect(formatBelowThresholdReply(report)).toBe(
            '12 of 12 current members are below level 10. Card shows the 10 closest. Full list is in the CSV.'
        );
    });
});
