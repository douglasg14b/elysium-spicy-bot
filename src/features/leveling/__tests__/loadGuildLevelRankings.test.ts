import { describe, expect, it, vi } from 'vitest';
import { loadGuildLevelRankings } from '../logic/loadGuildLevelRankings';

vi.mock('../data/levelingProgressRepo', () => ({
    levelingProgressRepo: {
        getGuildTopByTotalXp: vi.fn(),
        countGuildRankedMembers: vi.fn(),
    },
}));

import { levelingProgressRepo } from '../data/levelingProgressRepo';

describe('loadGuildLevelRankings', () => {
    it('returns ranked entries with activity metadata for moderator review', async () => {
        vi.mocked(levelingProgressRepo.getGuildTopByTotalXp).mockResolvedValue([
            {
                id: 1,
                guildId: 'guild-1',
                userId: 'user-a',
                totalXp: 5000,
                level: 12,
                messageCount: 120,
                reactionCount: 45,
                photoUploadCount: 6,
                lastMessageXpAt: new Date('2026-05-26T10:00:00Z'),
                lastReactionXpAt: new Date('2026-05-25T18:00:00Z'),
                voiceSessionCount: 0,
                totalVoiceSeconds: 0,
                lastVoiceXpAt: null,
                createdAt: new Date('2026-05-01T00:00:00Z'),
                updatedAt: new Date('2026-05-01T00:00:00Z'),
            },
        ]);
        vi.mocked(levelingProgressRepo.countGuildRankedMembers).mockResolvedValue(42);

        const result = await loadGuildLevelRankings({
            guildId: 'guild-1',
            limit: 10,
        });

        expect(result.entries).toEqual([
            {
                rank: 1,
                userId: 'user-a',
                totalXp: 5000,
                level: 12,
                messageCount: 120,
                reactionCount: 45,
                photoUploadCount: 6,
                lastActiveAt: new Date('2026-05-26T10:00:00Z'),
            },
        ]);
        expect(result.totalRankedMembers).toBe(42);
    });

    it('skips departed members and backfills the leaderboard from lower ranks', async () => {
        const rows = [
            {
                id: 1,
                guildId: 'guild-1',
                userId: 'departed',
                totalXp: 9000,
                level: 20,
                messageCount: 200,
                reactionCount: 50,
                photoUploadCount: 10,
                lastMessageXpAt: new Date('2026-05-26T10:00:00Z'),
                lastReactionXpAt: null,
                voiceSessionCount: 0,
                totalVoiceSeconds: 0,
                lastVoiceXpAt: null,
                createdAt: new Date('2026-05-01T00:00:00Z'),
                updatedAt: new Date('2026-05-01T00:00:00Z'),
            },
            {
                id: 2,
                guildId: 'guild-1',
                userId: 'active-a',
                totalXp: 8000,
                level: 18,
                messageCount: 180,
                reactionCount: 40,
                photoUploadCount: 8,
                lastMessageXpAt: new Date('2026-05-25T10:00:00Z'),
                lastReactionXpAt: null,
                voiceSessionCount: 0,
                totalVoiceSeconds: 0,
                lastVoiceXpAt: null,
                createdAt: new Date('2026-05-01T00:00:00Z'),
                updatedAt: new Date('2026-05-02T00:00:00Z'),
            },
            {
                id: 3,
                guildId: 'guild-1',
                userId: 'active-b',
                totalXp: 7000,
                level: 16,
                messageCount: 150,
                reactionCount: 35,
                photoUploadCount: 5,
                lastMessageXpAt: new Date('2026-05-24T10:00:00Z'),
                lastReactionXpAt: null,
                voiceSessionCount: 0,
                totalVoiceSeconds: 0,
                lastVoiceXpAt: null,
                createdAt: new Date('2026-05-01T00:00:00Z'),
                updatedAt: new Date('2026-05-03T00:00:00Z'),
            },
        ];

        vi.mocked(levelingProgressRepo.getGuildTopByTotalXp).mockResolvedValue(rows);
        vi.mocked(levelingProgressRepo.countGuildRankedMembers).mockResolvedValue(3);

        const result = await loadGuildLevelRankings({
            guildId: 'guild-1',
            limit: 2,
            isCurrentMember: async (userId) => userId !== 'departed',
        });

        expect(result.entries).toEqual([
            expect.objectContaining({ rank: 1, userId: 'active-a', totalXp: 8000 }),
            expect.objectContaining({ rank: 2, userId: 'active-b', totalXp: 7000 }),
        ]);
    });
});
