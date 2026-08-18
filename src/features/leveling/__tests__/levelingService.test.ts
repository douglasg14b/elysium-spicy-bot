import { describe, expect, it, vi, beforeEach } from 'vitest';
import { getTotalXpForLevel } from '../logic/xpCalculator';

const mockGetByGuildId = vi.fn();
const mockGrantXp = vi.fn();
const mockAnnounceLevelUp = vi.fn();
const mockGetVoiceXpSettings = vi.fn();

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

vi.mock('../logic/voiceXp', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../logic/voiceXp')>();
    return {
        ...actual,
        getVoiceXpSettings: (...args: unknown[]) => mockGetVoiceXpSettings(...args),
    };
});

import { LevelingService } from '../levelingService';
import {
    DEFAULT_VOICE_COOLDOWN_MS,
    DEFAULT_VOICE_MIN_ELIGIBLE_SECONDS,
    DEFAULT_VOICE_XP_PER_MINUTE,
} from '../constants';

function voiceXpSettings(overrides?: { voiceXpEnabled?: boolean }) {
    return {
        voiceXpPerMinute: DEFAULT_VOICE_XP_PER_MINUTE,
        voiceMinEligibleSeconds: DEFAULT_VOICE_MIN_ELIGIBLE_SECONDS,
        voiceCooldownMs: DEFAULT_VOICE_COOLDOWN_MS,
        voiceXpEnabled: false,
        ...overrides,
    };
}

describe('LevelingService', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockGetVoiceXpSettings.mockReturnValue(voiceXpSettings());
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

    it('skips voice XP when guild config is inactive', async () => {
        mockGetByGuildId.mockResolvedValue(null);
        const handleVoiceStateUpdate = vi.fn();
        const service = new LevelingService({} as never, { handleVoiceStateUpdate } as never);

        await service.handleVoiceStateUpdate(
            { guild: { id: 'guild-1' }, member: { user: { bot: false } } } as never,
            { guild: { id: 'guild-1' }, member: { user: { bot: false } } } as never
        );

        expect(handleVoiceStateUpdate).not.toHaveBeenCalled();
        expect(mockGrantXp).not.toHaveBeenCalled();
    });

    it('still tracks voice sessions when XP rewards are disabled', async () => {
        const handleVoiceStateUpdate = vi.fn();
        const reconcileGuild = vi.fn();
        const service = new LevelingService({} as never, {
            handleVoiceStateUpdate,
            reconcileGuild,
        } as never);

        await service.handleVoiceStateUpdate(
            { guild: { id: 'guild-1' }, member: { user: { bot: false } } } as never,
            { guild: { id: 'guild-1' }, member: { user: { bot: false } } } as never
        );
        await service.reconcileGuild({ id: 'guild-1' } as never);

        expect(handleVoiceStateUpdate).toHaveBeenCalled();
        expect(reconcileGuild).toHaveBeenCalledWith(
            expect.objectContaining({ id: 'guild-1' }),
            expect.objectContaining({ allowStartSessions: true })
        );
        expect(mockGrantXp).not.toHaveBeenCalled();
    });

    it('does not grant voice XP when a session ends while rewards are disabled', async () => {
        const consoleInfo = vi.spyOn(console, 'info').mockImplementation(() => undefined);
        const service = new LevelingService({} as never);

        await service.processVoiceSessionEnd({
            guildId: 'guild-1',
            userId: 'user-1',
            channelId: 'vc-1',
            eligibleMs: 180_000,
            sessionStartedAt: new Date('2026-08-17T11:57:00.000Z'),
            endedAt: new Date('2026-08-17T12:00:00.000Z'),
        });

        expect(mockGrantXp).not.toHaveBeenCalled();
        expect(mockAnnounceLevelUp).not.toHaveBeenCalled();
        expect(consoleInfo).toHaveBeenCalledWith(
            expect.stringContaining('Skipping voice XP grant while rewards are disabled')
        );
        consoleInfo.mockRestore();
    });

    it('grants voice XP and announces level-ups when a session ends', async () => {
        mockGetVoiceXpSettings.mockReturnValue(voiceXpSettings({ voiceXpEnabled: true }));
        const levelThreeTotalXp = getTotalXpForLevel(3);
        mockGrantXp.mockResolvedValue({
            previousTotalXp: 0,
            newTotalXp: levelThreeTotalXp,
            xpGranted: 36,
            progress: { totalXp: levelThreeTotalXp },
        });

        const service = new LevelingService({
            guilds: {
                cache: new Map([['guild-1', { id: 'guild-1' }]]),
            },
        } as never);

        await service.processVoiceSessionEnd({
            guildId: 'guild-1',
            userId: 'user-1',
            channelId: 'vc-1',
            eligibleMs: 180_000,
            sessionStartedAt: new Date('2026-08-17T11:57:00.000Z'),
            endedAt: new Date('2026-08-17T12:00:00.000Z'),
        });

        expect(mockGrantXp).toHaveBeenCalledWith(
            expect.objectContaining({
                activityType: 'voice',
                xpAmount: 36,
                incrementVoiceSessionCount: true,
                addVoiceSeconds: 180,
                voiceEligibleSeconds: 180,
                voiceChannelId: 'vc-1',
                voiceEligibilityRule: 'min_2_non_bots',
            })
        );
        expect(mockAnnounceLevelUp).toHaveBeenCalledTimes(2);
    });

    it('still grants message XP after voice handling throws', async () => {
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const handleVoiceStateUpdate = vi.fn().mockRejectedValue(new Error('voice exploded'));
        const service = new LevelingService({} as never, { handleVoiceStateUpdate } as never);
        mockGrantXp.mockResolvedValue(null);

        await expect(
            service.handleVoiceStateUpdate(
                { guild: { id: 'guild-1' }, member: { user: { bot: false } } } as never,
                { guild: { id: 'guild-1' }, member: { user: { bot: false } } } as never
            )
        ).resolves.toBeUndefined();

        await service.handleMessageCreate({
            system: false,
            guildId: 'guild-1',
            guild: { id: 'guild-1' },
            author: { id: 'user-1', bot: false },
            content: 'hello',
            attachments: { values: () => [] },
        } as never);

        expect(mockGrantXp).toHaveBeenCalledWith(
            expect.objectContaining({
                activityType: 'message',
            })
        );
        expect(consoleError).toHaveBeenCalled();
        consoleError.mockRestore();
    });
});
