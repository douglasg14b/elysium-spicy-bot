import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    getAllEnabled: vi.fn(),
    has: vi.fn(),
    startInstance: vi.fn(),
    getGuildLabel: vi.fn(),
}));

vi.mock('../data/flashChatRepo', () => ({
    flashChatRepo: {
        getAllEnabled: mocks.getAllEnabled,
    },
}));

vi.mock('../flashChatManager', () => ({
    flashChatManager: {
        has: mocks.has,
        startInstance: mocks.startInstance,
        getGuildLabel: mocks.getGuildLabel,
    },
}));

import { flashChatService } from '../flashChatService';

describe('flashChatService.startAll', () => {
    beforeEach(() => {
        vi.clearAllMocks();
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
