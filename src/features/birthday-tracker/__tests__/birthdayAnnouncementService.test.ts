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
    markAnnounced: vi.fn(),
    clearAnnouncementClaim: vi.fn(),
    getConfig: vi.fn(),
    generate: vi.fn(),
    resolveChannel: vi.fn(),
}));

vi.mock('../data/birthdayRepo', () => ({
    birthdayRepository: {
        findDueForAnnouncementToday: hoisted.findDue,
        markAnnounced: hoisted.markAnnounced,
        clearAnnouncementClaim: hoisted.clearAnnouncementClaim,
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

describe('executeBirthdayAnnouncementTick', () => {
    const minimalClient = { user: { id: 'bot' } } as unknown as Client;

    beforeEach(() => {
        hoisted.findDue.mockReset();
        hoisted.markAnnounced.mockReset();
        hoisted.clearAnnouncementClaim.mockReset();
        hoisted.getConfig.mockReset();
        hoisted.generate.mockReset();
        hoisted.resolveChannel.mockReset();
    });

    it('skips when no announcement channel is configured and does not mark announced', async () => {
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
        expect(hoisted.markAnnounced).not.toHaveBeenCalled();
        expect(hoisted.clearAnnouncementClaim).not.toHaveBeenCalled();
    });

    it('marks announced after successful send with AI text', async () => {
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
        expect(hoisted.markAnnounced).toHaveBeenCalledWith('g1', 'u1');
        expect(hoisted.clearAnnouncementClaim).not.toHaveBeenCalled();
        expect(hoisted.markAnnounced.mock.invocationCallOrder[0]).toBeLessThan(
            send.mock.invocationCallOrder[0] ?? Infinity
        );
    });

    it('uses fallback when AI fails and still marks announced after send', async () => {
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
        expect(hoisted.markAnnounced).toHaveBeenCalledWith('g1', 'u1');
        expect(hoisted.clearAnnouncementClaim).not.toHaveBeenCalled();
    });

    it('clears announcement claim when send fails after a successful persist', async () => {
        const send = vi.fn().mockRejectedValue(new Error('network'));
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

        hoisted.clearAnnouncementClaim.mockResolvedValue(undefined);

        await executeBirthdayAnnouncementTick(minimalClient);

        expect(hoisted.markAnnounced).toHaveBeenCalledWith('g1', 'u1');
        expect(hoisted.clearAnnouncementClaim).toHaveBeenCalledWith('g1', 'u1');
    });

    it('does not run two ticks concurrently so a second pass cannot duplicate-send before markAnnounced', async () => {
        const dueRow = {
            guildId: 'g1',
            userId: 'u1',
            displayName: 'Pat',
            username: 'pat',
            month: 3,
            day: 1,
            year: null,
        };
        let persistCompleted = false;
        hoisted.findDue.mockImplementation(async () => {
            if (persistCompleted) {
                return [];
            }
            return [dueRow];
        });
        const send = vi.fn(
            () => new Promise<void>((resolve) => setTimeout(resolve, 40))
        );
        const channel = { send } as unknown as TextChannel;
        hoisted.getConfig.mockResolvedValue({ announcementChannelId: 'ch1' });
        hoisted.resolveChannel.mockResolvedValue(channel);
        hoisted.generate.mockResolvedValue('Happy day.');
        hoisted.markAnnounced.mockImplementation(async () => {
            persistCompleted = true;
        });
        hoisted.clearAnnouncementClaim.mockResolvedValue(undefined);

        enqueueBirthdayAnnouncementTick(minimalClient);
        enqueueBirthdayAnnouncementTick(minimalClient);

        await new Promise((resolve) => setTimeout(resolve, 200));

        expect(send).toHaveBeenCalledTimes(1);
        expect(hoisted.markAnnounced).toHaveBeenCalledTimes(1);
        expect(hoisted.clearAnnouncementClaim).not.toHaveBeenCalled();
    });

    it('retries markAnnounced before send and succeeds on a later attempt', async () => {
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
        hoisted.markAnnounced
            .mockRejectedValueOnce(new Error('db busy'))
            .mockRejectedValueOnce(new Error('db busy'))
            .mockResolvedValue(undefined);
        hoisted.clearAnnouncementClaim.mockResolvedValue(undefined);

        await executeBirthdayAnnouncementTick(minimalClient);

        expect(send).toHaveBeenCalledTimes(1);
        expect(hoisted.markAnnounced).toHaveBeenCalledTimes(3);
        expect(hoisted.clearAnnouncementClaim).not.toHaveBeenCalled();
    });

    it('does not send when markAnnounced never succeeds', async () => {
        const send = vi.fn().mockResolvedValue(undefined);
        const channel = { send } as unknown as TextChannel;
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
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
        hoisted.markAnnounced.mockRejectedValue(new Error('db down'));

        await executeBirthdayAnnouncementTick(minimalClient);

        expect(send).not.toHaveBeenCalled();
        expect(hoisted.markAnnounced).toHaveBeenCalledTimes(4);
        expect(errorSpy).toHaveBeenCalledWith(
            expect.stringContaining('announcement claim could not be persisted'),
            expect.any(Error)
        );
        errorSpy.mockRestore();
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
