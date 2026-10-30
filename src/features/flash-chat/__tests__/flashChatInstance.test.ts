import { ChannelType, Collection, PermissionsBitField, type Client } from 'discord.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FlashChatConfig } from '../data/flashChatSchema';

const deleteMessageSafely = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('../utils', () => ({ deleteMessageSafely }));

const { FlashChatInstance } = await import('../flashChatInstance');

/**
 * The instance's two background jobs — the history purge a save with "keep history" off
 * starts, and the periodic sweep — against a fake channel. What matters is when they stop:
 * an edit or a turn-off stops the instance, and nothing it started may go on deleting.
 */

const NOW = new Date('2026-10-29T12:00:00.000Z').getTime();
const CHANNEL_ID = 'channel-1';

function fakeMessage(id: string, minutesAgo: number) {
    return { id, pinned: false, createdTimestamp: NOW - minutesAgo * 60_000, author: { tag: 'someone' } };
}

function page(messages: ReturnType<typeof fakeMessage>[]) {
    return new Collection(messages.map((message) => [message.id, message]));
}

function setUp(fetch: ReturnType<typeof vi.fn>, preserveHistory: boolean) {
    const channel = {
        id: CHANNEL_ID,
        name: 'confessions',
        type: ChannelType.GuildText,
        permissionsFor: () => new PermissionsBitField(PermissionsBitField.All),
        messages: { fetch },
        bulkDelete: vi.fn().mockResolvedValue(undefined),
    };
    const guild = { id: 'guild-1', members: { me: { id: 'bot' } }, channels: { cache: new Map([[CHANNEL_ID, channel]]) } };
    const client = {
        guilds: { cache: new Map([['guild-1', guild]]) },
        channels: { cache: new Map([[CHANNEL_ID, channel]]) },
    } as unknown as Client;
    const config = {
        guildId: 'guild-1',
        channelId: CHANNEL_ID,
        timeoutSeconds: 60,
        preservePinned: false,
        preserveHistory,
        createdAt: new Date(NOW - 24 * 60 * 60_000),
    } as FlashChatConfig;
    return { instance: new FlashChatInstance(config, client), channel };
}

beforeEach(() => {
    vi.useFakeTimers({ now: NOW });
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
});

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    deleteMessageSafely.mockClear();
});

describe('FlashChatInstance', () => {
    it('abandons the history purge when stopped during its wait, deleting nothing', async () => {
        const fetch = vi.fn().mockResolvedValue(page([fakeMessage('old-1', 10), fakeMessage('old-2', 20)]));
        const { instance, channel } = setUp(fetch, false);

        instance.start();
        // The purge has fetched its first page and is in the three-second wait before deleting.
        await vi.advanceTimersByTimeAsync(100);
        instance.stop();
        await vi.advanceTimersByTimeAsync(10_000);

        expect(channel.bulkDelete).not.toHaveBeenCalled();
        expect(deleteMessageSafely).not.toHaveBeenCalled();
    });

    it('sweeps past a full page of messages still inside the timer to the expired ones behind it', async () => {
        const recent = Array.from({ length: 100 }, (_, index) => fakeMessage(`recent-${index}`, 0.5));
        const expired = [fakeMessage('expired-1', 5), fakeMessage('expired-2', 6)];
        const fetch = vi
            .fn()
            .mockImplementation(async ({ before }: { before?: string }) => (before ? page(expired) : page(recent)));
        const { instance } = setUp(fetch, true);

        instance.start();
        await vi.advanceTimersByTimeAsync(600);
        instance.stop();

        expect(fetch).toHaveBeenCalledWith({ limit: 100, before: 'recent-99' });
        expect(deleteMessageSafely.mock.calls.map(([message]) => message.id)).toEqual(['expired-1', 'expired-2']);
    });
});
