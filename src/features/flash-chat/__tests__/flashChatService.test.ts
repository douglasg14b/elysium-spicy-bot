import { ChannelType, type Guild, type TextChannel } from 'discord.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    getAllEnabled: vi.fn(),
    get: vi.fn(),
    insert: vi.fn(),
    updateSettings: vi.fn(),
    delete: vi.fn(),
    has: vi.fn(),
    startInstance: vi.fn(),
    stopInstance: vi.fn(),
    getGuildLabel: vi.fn(),
}));

vi.mock('../data/flashChatRepo', () => ({
    flashChatRepo: {
        getAllEnabled: mocks.getAllEnabled,
        get: mocks.get,
        insert: mocks.insert,
        updateSettings: mocks.updateSettings,
        delete: mocks.delete,
    },
}));

vi.mock('../flashChatManager', () => ({
    flashChatManager: {
        has: mocks.has,
        startInstance: mocks.startInstance,
        stopInstance: mocks.stopInstance,
        getGuildLabel: mocks.getGuildLabel,
    },
}));

import { flashChatService } from '../flashChatService';

const SETTINGS = { timeoutSeconds: 300, preservePinned: true, preserveHistory: false };
const EDITOR = { id: 'user-1', username: 'mod' };

function fakeChannel(send = vi.fn().mockResolvedValue(undefined)) {
    const channel = {
        id: 'channel-1',
        name: 'spicy-pics',
        type: ChannelType.GuildText,
        guild: { id: 'guild-1' },
        send,
    };
    return channel as unknown as TextChannel & { send: typeof send };
}

function fakeGuild(channel: TextChannel | undefined): Guild {
    return {
        id: 'guild-1',
        channels: { cache: { get: (id: string) => (channel && id === channel.id ? channel : undefined) } },
    } as unknown as Guild;
}

function storedRow(timeoutSeconds: number) {
    return { guildId: 'guild-1', channelId: 'channel-1', timeoutSeconds, preservePinned: true, preserveHistory: false };
}

describe('flashChatService.configure', () => {
    beforeEach(() => {
        // Reset, not clear: a test below installs implementations the next must not inherit.
        vi.resetAllMocks();
        mocks.has.mockReturnValue(undefined);
    });

    it('sets a new channel up, starts it, and tells the channel', async () => {
        const channel = fakeChannel();
        mocks.get.mockResolvedValueOnce(null).mockResolvedValueOnce(storedRow(300));

        const saved = await flashChatService.configure({ channel, settings: SETTINGS, by: EDITOR });

        expect(saved).toEqual(storedRow(300));
        expect(mocks.insert).toHaveBeenCalledWith('guild-1', 'channel-1', SETTINGS, EDITOR);
        expect(mocks.updateSettings).not.toHaveBeenCalled();
        expect(mocks.startInstance).toHaveBeenCalledWith(storedRow(300));
        expect(channel.send).toHaveBeenCalledWith({
            embeds: [expect.objectContaining({ title: '⚡ Flash Chat Enabled' })],
        });
    });

    it('restarts a running channel on an edit, and stays quiet when the timer did not change', async () => {
        const channel = fakeChannel();
        mocks.get.mockResolvedValueOnce(storedRow(300)).mockResolvedValueOnce(storedRow(300));
        mocks.has.mockReturnValue({});

        await flashChatService.configure({
            channel,
            settings: { ...SETTINGS, preserveHistory: true },
            by: EDITOR,
        });

        expect(mocks.updateSettings).toHaveBeenCalled();
        expect(mocks.insert).not.toHaveBeenCalled();
        expect(mocks.stopInstance).toHaveBeenCalledWith('guild-1', 'channel-1');
        expect(mocks.startInstance).toHaveBeenCalledTimes(1);
        expect(mocks.stopInstance.mock.invocationCallOrder[0]).toBeLessThan(
            mocks.startInstance.mock.invocationCallOrder[0],
        );
        expect(channel.send).not.toHaveBeenCalled();
    });

    it('tells the channel when the timer changes', async () => {
        const channel = fakeChannel();
        mocks.get.mockResolvedValueOnce(storedRow(60)).mockResolvedValueOnce(storedRow(300));

        await flashChatService.configure({ channel, settings: SETTINGS, by: EDITOR });

        expect(channel.send).toHaveBeenCalledTimes(1);
        expect(channel.send.mock.calls[0][0].embeds[0].description).toContain('5m');
    });

    it('leaves a running channel alone when the save changes nothing, keeping its pending timers', async () => {
        mocks.get.mockResolvedValueOnce(storedRow(300)).mockResolvedValueOnce(storedRow(300));
        mocks.has.mockReturnValue({});

        await flashChatService.configure({ channel: fakeChannel(), settings: SETTINGS, by: EDITOR });

        expect(mocks.stopInstance).not.toHaveBeenCalled();
        expect(mocks.startInstance).not.toHaveBeenCalled();
    });

    it('saves and answers the row when the instance cannot start, so the channel lists as not running', async () => {
        mocks.get.mockResolvedValueOnce(null).mockResolvedValueOnce(storedRow(300));
        mocks.startInstance.mockImplementationOnce(() => {
            throw new Error('Channel ID channel-1 not found in cache.');
        });
        const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

        try {
            await expect(
                flashChatService.configure({ channel: fakeChannel(), settings: SETTINGS, by: EDITOR }),
            ).resolves.toEqual(storedRow(300));
            expect(error).toHaveBeenCalled();
        } finally {
            error.mockRestore();
        }
    });

    it('runs a save and a removal of the same channel one after the other', async () => {
        const rows: Array<ReturnType<typeof storedRow> | null> = [null];
        mocks.get.mockImplementation(async () => rows[0]);
        mocks.insert.mockImplementation(async () => {
            rows[0] = storedRow(300);
        });
        mocks.delete.mockImplementation(async () => {
            rows[0] = null;
        });
        let running = false;
        mocks.has.mockImplementation(() => (running ? {} : undefined));
        mocks.startInstance.mockImplementation(() => {
            running = true;
        });
        mocks.stopInstance.mockImplementation(() => {
            running = false;
        });
        const channel = fakeChannel();

        // Started together, as two tabs would: the removal must see the save's row and stop its instance.
        await Promise.all([
            flashChatService.configure({ channel, settings: SETTINGS, by: EDITOR }),
            flashChatService.remove(fakeGuild(channel), 'channel-1'),
        ]);

        expect(rows[0]).toBeNull();
        expect(running).toBe(false);
    });

    it('keeps the change when the notice cannot be posted', async () => {
        const channel = fakeChannel(vi.fn().mockRejectedValue(new Error('Missing Access')));
        mocks.get.mockResolvedValueOnce(null).mockResolvedValueOnce(storedRow(300));
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

        try {
            await expect(flashChatService.configure({ channel, settings: SETTINGS, by: EDITOR })).resolves.toEqual(
                storedRow(300),
            );
            expect(mocks.startInstance).toHaveBeenCalled();
            expect(warn).toHaveBeenCalled();
        } finally {
            warn.mockRestore();
        }
    });
});

describe('flashChatService.remove', () => {
    beforeEach(() => {
        // Reset, not clear: a test below installs implementations the next must not inherit.
        vi.resetAllMocks();
        mocks.has.mockReturnValue(undefined);
    });

    it('removes a channel whose instance is not running, and tells the channel', async () => {
        const channel = fakeChannel();
        mocks.get.mockResolvedValueOnce(storedRow(300));

        const removed = await flashChatService.remove(fakeGuild(channel), 'channel-1');

        expect(removed).toEqual(storedRow(300));
        expect(mocks.stopInstance).not.toHaveBeenCalled();
        expect(mocks.delete).toHaveBeenCalledWith('guild-1', 'channel-1');
        expect(channel.send).toHaveBeenCalledWith({
            embeds: [expect.objectContaining({ title: '⚡ Flash Chat Disabled' })],
        });
    });

    it('stops a running instance, and removes a channel Discord has deleted without posting', async () => {
        mocks.get.mockResolvedValueOnce(storedRow(300));
        mocks.has.mockReturnValue({});

        await flashChatService.remove(fakeGuild(undefined), 'channel-1');

        expect(mocks.stopInstance).toHaveBeenCalledWith('guild-1', 'channel-1');
        expect(mocks.delete).toHaveBeenCalledWith('guild-1', 'channel-1');
        // The row first, so a failed delete leaves the channel running rather than listed but stopped.
        expect(mocks.delete.mock.invocationCallOrder[0]).toBeLessThan(mocks.stopInstance.mock.invocationCallOrder[0]);
    });

    it('answers null for a channel with no flash chat, and touches nothing', async () => {
        mocks.get.mockResolvedValueOnce(null);

        await expect(flashChatService.remove(fakeGuild(undefined), 'channel-1')).resolves.toBeNull();
        expect(mocks.delete).not.toHaveBeenCalled();
        expect(mocks.stopInstance).not.toHaveBeenCalled();
    });
});

describe('flashChatService.startAll', () => {
    beforeEach(() => {
        // Reset, not clear: a test below installs implementations the next must not inherit.
        vi.resetAllMocks();
        mocks.has.mockReturnValue(undefined);
        mocks.getGuildLabel.mockImplementation((guildId: string) => `Guild ${guildId}`);
        mocks.startInstance.mockImplementation((config: { channelId: string }) => {
            if (config.channelId === 'bad-channel') {
                throw new Error('missing channel');
            }
        });
    });

    it('continues starting later channels when one channel fails', async () => {
        mocks.getAllEnabled.mockResolvedValue([
            { guildId: 'guild-1', channelId: 'bad-channel' },
            { guildId: 'guild-2', channelId: 'good-channel' },
        ]);

        const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

        try {
            await expect(flashChatService.startAll()).resolves.toBeUndefined();

            expect(mocks.startInstance).toHaveBeenCalledTimes(2);
            expect(mocks.startInstance).toHaveBeenNthCalledWith(
                1,
                expect.objectContaining({ guildId: 'guild-1', channelId: 'bad-channel' }),
            );
            expect(mocks.startInstance).toHaveBeenNthCalledWith(
                2,
                expect.objectContaining({ guildId: 'guild-2', channelId: 'good-channel' }),
            );
            expect(consoleErrorSpy).toHaveBeenCalledWith(
                '❌ Failed to start flash chat for Guild guild-1/bad-channel:',
                expect.any(Error),
            );
            expect(consoleLogSpy).toHaveBeenCalledWith('🚀 Starting flash chat for Guild guild-2/good-channel');
            expect(consoleLogSpy).toHaveBeenCalledWith('✅ Started flash chat for Guild guild-2/good-channel');
        } finally {
            consoleErrorSpy.mockRestore();
            consoleLogSpy.mockRestore();
        }
    });
});
