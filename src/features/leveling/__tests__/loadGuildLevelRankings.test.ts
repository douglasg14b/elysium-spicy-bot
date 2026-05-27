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
});
