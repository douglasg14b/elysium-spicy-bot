import { describe, expect, it, vi, beforeEach } from 'vitest';
import { getTotalXpForLevel } from '../logic/xpCalculator';

const mockGetByGuildId = vi.fn();
const mockGrantXp = vi.fn();
const mockAnnounceLevelUp = vi.fn();

vi.mock('../data/levelingConfigRepo', () => ({
    levelingConfigRepo: {
        getByGuildId: (...args: unknown[]) => mockGetByGuildId(...args),
    },
}));

vi.mock('../data/levelingProgressRepo', () => ({
    levelingProgressRepo: {
        grantXp: (...args: unknown[]) => mockGrantXp(...args),
    },
}));

vi.mock('../levelUpAnnouncer', () => ({
    announceLevelUp: (...args: unknown[]) => mockAnnounceLevelUp(...args),
}));

import { LevelingService } from '../levelingService';

describe('LevelingService', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockGetByGuildId.mockResolvedValue({
            enabled: true,
            notificationChannelId: '999',
            messageXpMin: 15,
            messageXpMax: 25,
            messageCooldownMs: 20_000,
            reactionXpMin: 1,
            reactionXpMax: 2,
            reactionCooldownMs: 180_000,
            reactionXpEnabled: true,
            photoBonusEnabled: true,
            photoXpBonusMin: 10,
            photoXpBonusMax: 20,
        });
    });

    it('skips XP when guild config is inactive', async () => {
        mockGetByGuildId.mockResolvedValue(null);
        const service = new LevelingService({} as never);

        await service.handleMessageCreate({
            system: false,
            guildId: 'guild-1',
            guild: { id: 'guild-1' },
            author: { id: 'user-1', bot: false },
            content: 'hello',
            attachments: { values: () => [] },
        } as never);

        expect(mockGrantXp).not.toHaveBeenCalled();
    });

    it('announces each level crossed on multi-level jumps', async () => {
        const levelThreeTotalXp = getTotalXpForLevel(3);
        mockGrantXp.mockResolvedValue({
            previousTotalXp: 0,
            newTotalXp: levelThreeTotalXp,
            xpGranted: levelThreeTotalXp,
            progress: { totalXp: levelThreeTotalXp },
        });

        const service = new LevelingService({} as never);

        await service.handleMessageCreate({
            system: false,
            guildId: 'guild-1',
            guild: { id: 'guild-1' },
            author: { id: 'user-1', bot: false },
            content: 'hello',
            attachments: { values: () => [] },
        } as never);

        expect(mockGrantXp).toHaveBeenCalledOnce();
        expect(mockAnnounceLevelUp).toHaveBeenCalledTimes(2);
        expect(mockAnnounceLevelUp.mock.calls[0]?.[0]).toMatchObject({ level: 2, userId: 'user-1' });
        expect(mockAnnounceLevelUp.mock.calls[1]?.[0]).toMatchObject({ level: 3, userId: 'user-1' });
    });

    it('grants length-scaled message XP', async () => {
        mockGrantXp.mockResolvedValue(null);
        const service = new LevelingService({} as never);

        await service.handleMessageCreate({
            system: false,
            guildId: 'guild-1',
            guild: { id: 'guild-1' },
            author: { id: 'user-1', bot: false },
            content: 'hello',
            attachments: { values: () => [] },
        } as never);

        expect(mockGrantXp.mock.calls[0]?.[0]?.xpAmount).toBe(8);

        await service.handleMessageCreate({
            system: false,
            guildId: 'guild-1',
            guild: { id: 'guild-1' },
            author: { id: 'user-1', bot: false },
            content: 'x'.repeat(300),
            attachments: { values: () => [] },
        } as never);

        expect(mockGrantXp.mock.calls[1]?.[0]?.xpAmount).toBe(25);
    });

    it('grants random XP between 1 and 2 for reactions', async () => {
        mockGrantXp.mockResolvedValue(null);
        const service = new LevelingService({} as never);

        await service.handleReactionAdd(
            {
                partial: false,
                message: { partial: false, guildId: 'guild-1', guild: { id: 'guild-1' } },
            } as never,
            { bot: false, partial: false, id: 'user-1' } as never
        );

        const xpAmount = mockGrantXp.mock.calls[0]?.[0]?.xpAmount;
        expect(xpAmount).toBeGreaterThanOrEqual(1);
        expect(xpAmount).toBeLessThanOrEqual(2);
        expect(mockGrantXp.mock.calls[0]?.[0]?.activityType).toBe('reaction');
    });

    it('does not announce when XP grant is skipped by cooldown', async () => {
        mockGrantXp.mockResolvedValue(null);
        const service = new LevelingService({} as never);

        await service.handleMessageCreate({
            system: false,
            guildId: 'guild-1',
            guild: { id: 'guild-1' },
            author: { id: 'user-1', bot: false },
            content: 'hello',
            attachments: { values: () => [] },
        } as never);

        expect(mockAnnounceLevelUp).not.toHaveBeenCalled();
    });
});
