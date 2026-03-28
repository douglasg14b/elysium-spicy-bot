import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Client, TextChannel } from 'discord.js';
import {
    BIRTHDAY_ANNOUNCEMENT_INTERVAL_MS,
    enqueueBirthdayAnnouncementTick,
    executeBirthdayAnnouncementTick,
    startBirthdayAnnouncementScheduler,
    stopBirthdayAnnouncementScheduler,
} from '../birthdayAnnouncementService';

const hoisted = vi.hoisted(() => ({
    findDue: vi.fn(),
    claim: vi.fn(),
    revert: vi.fn(),
    getConfig: vi.fn(),
    generate: vi.fn(),
    resolveChannel: vi.fn(),
}));

vi.mock('../data/birthdayRepo', () => ({
    birthdayRepository: {
        findDueForAnnouncementToday: hoisted.findDue,
        claimAnnouncementIfDue: hoisted.claim,
        revertAnnouncementClaim: hoisted.revert,
    },
}));

vi.mock('../data/birthdayConfigRepo', () => ({
    birthdayConfigRepository: {
        getByGuildId: hoisted.getConfig,
    },
}));

vi.mock('../../ai-reply/aiService', () => ({
    aiService: {
        generateBirthdayAnnouncement: hoisted.generate,
    },
}));

vi.mock('../birthdayChannelResolver', () => ({
    resolveBirthdayAnnouncementChannel: hoisted.resolveChannel,
}));

const defaultClaim = {
    claimed: true as const,
    claimAt: new Date('2026-03-28T12:00:00.000Z'),
    previousLastAnnouncedAt: null as Date | null,
};

describe('executeBirthdayAnnouncementTick', () => {
    const minimalClient = { user: { id: 'bot' } } as unknown as Client;

    beforeEach(() => {
        hoisted.findDue.mockReset();
        hoisted.claim.mockReset();
        hoisted.revert.mockReset();
        hoisted.getConfig.mockReset();
        hoisted.generate.mockReset();
        hoisted.resolveChannel.mockReset();
        hoisted.claim.mockResolvedValue(defaultClaim);
        hoisted.revert.mockResolvedValue(undefined);
    });

    afterEach(() => {
        stopBirthdayAnnouncementScheduler();
    });

    it('skips when no announcement channel is configured and does not claim', async () => {
        hoisted.findDue.mockResolvedValue([
            {
                guildId: 'g1',
                userId: 'u1',
                displayName: 'Pat',
                username: 'pat',
                month: 3,
                day: 1,
                year: null,
            },
        ]);
        hoisted.getConfig.mockResolvedValue(null);

        await executeBirthdayAnnouncementTick(minimalClient);

        expect(hoisted.resolveChannel).not.toHaveBeenCalled();
        expect(hoisted.claim).not.toHaveBeenCalled();
    });

    it('claims before send on success', async () => {
        const send = vi.fn().mockResolvedValue(undefined);
        const channel = { send } as unknown as TextChannel;
        hoisted.findDue.mockResolvedValue([
            {
                guildId: 'g1',
                userId: 'u1',
                displayName: 'Pat',
                username: 'pat',
                month: 3,
                day: 1,
                year: null,
            },
        ]);
        hoisted.getConfig.mockResolvedValue({ announcementChannelId: 'ch1' });
        hoisted.resolveChannel.mockResolvedValue(channel);
        hoisted.generate.mockResolvedValue('Happy chaos day, Pat.');

        await executeBirthdayAnnouncementTick(minimalClient);

        expect(send).toHaveBeenCalledTimes(1);
        expect(hoisted.claim).toHaveBeenCalledWith('g1', 'u1');
        expect(hoisted.claim.mock.invocationCallOrder[0]).toBeLessThan(send.mock.invocationCallOrder[0] ?? Infinity);
        expect(hoisted.revert).not.toHaveBeenCalled();
    });

    it('uses fallback when AI fails and does not revert after send', async () => {
        const send = vi.fn().mockResolvedValue(undefined);
        const channel = { send } as unknown as TextChannel;
        hoisted.findDue.mockResolvedValue([
            {
                guildId: 'g1',
                userId: 'u1',
                displayName: 'Pat',
                username: 'pat',
                month: 3,
                day: 1,
                year: null,
            },
        ]);
        hoisted.getConfig.mockResolvedValue({ announcementChannelId: 'ch1' });
        hoisted.resolveChannel.mockResolvedValue(channel);
        hoisted.generate.mockRejectedValue(new Error('OpenAI down'));

        await executeBirthdayAnnouncementTick(minimalClient);

        expect(send).toHaveBeenCalledTimes(1);
        const payload = send.mock.calls[0][0] as { content: string };
        expect(payload.content).toContain('Pat');
        expect(hoisted.revert).not.toHaveBeenCalled();
    });

    it('reverts claim when send fails', async () => {
        const send = vi.fn().mockRejectedValue(new Error('network'));
        const channel = { send } as unknown as TextChannel;
        const claimAt = new Date('2026-03-28T15:00:00.000Z');
        hoisted.findDue.mockResolvedValue([
            {
                guildId: 'g1',
                userId: 'u1',
                displayName: 'Pat',
                username: 'pat',
                month: 3,
                day: 1,
                year: null,
            },
        ]);
        hoisted.getConfig.mockResolvedValue({ announcementChannelId: 'ch1' });
        hoisted.resolveChannel.mockResolvedValue(channel);
        hoisted.generate.mockResolvedValue('Short line');
        hoisted.claim.mockResolvedValue({
            claimed: true,
            claimAt,
            previousLastAnnouncedAt: null,
        });

        await executeBirthdayAnnouncementTick(minimalClient);

        expect(send).toHaveBeenCalledTimes(1);
        expect(hoisted.revert).toHaveBeenCalledWith('g1', 'u1', claimAt, null);
    });

    it('does not run two ticks concurrently so a second pass cannot duplicate-send before claim wins', async () => {
        const dueRow = {
            guildId: 'g1',
            userId: 'u1',
            displayName: 'Pat',
            username: 'pat',
            month: 3,
            day: 1,
            year: null,
        };
        let findDueCalls = 0;
        hoisted.findDue.mockImplementation(async () => {
            findDueCalls += 1;
            if (findDueCalls >= 2) {
                return [];
            }
            return [dueRow];
        });
        const send = vi.fn(() => new Promise<void>((resolve) => setTimeout(resolve, 40)));
        const channel = { send } as unknown as TextChannel;
        hoisted.getConfig.mockResolvedValue({ announcementChannelId: 'ch1' });
        hoisted.resolveChannel.mockResolvedValue(channel);
        hoisted.generate.mockResolvedValue('Happy day.');

        enqueueBirthdayAnnouncementTick(minimalClient);
        enqueueBirthdayAnnouncementTick(minimalClient);

        await new Promise((resolve) => setTimeout(resolve, 200));

        expect(send).toHaveBeenCalledTimes(1);
        expect(hoisted.claim).toHaveBeenCalledTimes(1);
    });

    it('skips send when claim loses the race', async () => {
        const send = vi.fn().mockResolvedValue(undefined);
        const channel = { send } as unknown as TextChannel;
        hoisted.findDue.mockResolvedValue([
            {
                guildId: 'g1',
                userId: 'u1',
                displayName: 'Pat',
                username: 'pat',
                month: 3,
                day: 1,
                year: null,
            },
        ]);
        hoisted.getConfig.mockResolvedValue({ announcementChannelId: 'ch1' });
        hoisted.resolveChannel.mockResolvedValue(channel);
        hoisted.generate.mockResolvedValue('Short line');
        hoisted.claim.mockResolvedValue({ claimed: false });

        await executeBirthdayAnnouncementTick(minimalClient);

        expect(send).not.toHaveBeenCalled();
        expect(hoisted.revert).not.toHaveBeenCalled();
    });

    it('retries send on a later tick after revert', async () => {
        const send = vi.fn().mockRejectedValueOnce(new Error('network')).mockResolvedValue(undefined);
        const channel = { send } as unknown as TextChannel;
        const claimAt = new Date('2026-03-28T16:00:00.000Z');
        hoisted.findDue.mockResolvedValue([
            {
                guildId: 'g1',
                userId: 'u1',
                displayName: 'Pat',
                username: 'pat',
                month: 3,
                day: 1,
                year: null,
            },
        ]);
        hoisted.getConfig.mockResolvedValue({ announcementChannelId: 'ch1' });
        hoisted.resolveChannel.mockResolvedValue(channel);
        hoisted.generate.mockResolvedValue('Short line');
        hoisted.claim.mockResolvedValue({
            claimed: true,
            claimAt,
            previousLastAnnouncedAt: null,
        });

        await executeBirthdayAnnouncementTick(minimalClient);
        await executeBirthdayAnnouncementTick(minimalClient);

        expect(send).toHaveBeenCalledTimes(2);
        expect(hoisted.revert).toHaveBeenCalledTimes(1);
        expect(hoisted.claim).toHaveBeenCalledTimes(2);
    });
});

describe('startBirthdayAnnouncementScheduler', () => {
    afterEach(() => {
        stopBirthdayAnnouncementScheduler();
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it('registers only one interval when started twice', () => {
        vi.useFakeTimers();
        const client = { user: { id: 'bot' } } as unknown as Client;
        hoisted.findDue.mockResolvedValue([]);

        const spy = vi.spyOn(globalThis, 'setInterval');

        startBirthdayAnnouncementScheduler(client);
        startBirthdayAnnouncementScheduler(client);

        expect(spy).toHaveBeenCalledTimes(1);
        expect(spy.mock.calls[0][1]).toBe(BIRTHDAY_ANNOUNCEMENT_INTERVAL_MS);
    });
});
