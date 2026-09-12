import type { Guild } from 'discord.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WarningsConfig } from '../../data/warningsConfigSchema';
import type { WarningsConfigRepo } from '../../data/warningsConfigRepo';
import type { WarningModChannelValidation } from '../warningModChannel';
import { setWarningsModChannel } from '../setWarningsModChannel';

vi.mock('../warningModChannel', () => ({
    validateWarningsModChannel: vi.fn(),
}));

const { validateWarningsModChannel } = await import('../warningModChannel');
const validateMock = vi.mocked(validateWarningsModChannel);

/** A fake guild — the shared function only forwards it to the (mocked) validator. */
const fakeGuild = { id: 'guild-1' } as unknown as Guild;

function fakeRepo(overrides: Partial<WarningsConfigRepo> = {}): WarningsConfigRepo {
    return {
        getByGuildId: vi.fn(),
        upsertModChannel: vi.fn(),
        ...overrides,
    } as unknown as WarningsConfigRepo;
}

const savedConfig: WarningsConfig = {
    id: 1,
    guildId: 'guild-1',
    modChannelId: 'channel-1',
    createdAt: new Date(),
    updatedAt: new Date(),
    configVersion: 1,
};

describe('setWarningsModChannel', () => {
    beforeEach(() => {
        validateMock.mockReset();
    });

    it('validates then persists, returning the saved config on success', async () => {
        validateMock.mockResolvedValue({ ok: true, channelId: 'channel-1' });
        const upsertModChannel = vi.fn().mockResolvedValue(savedConfig);
        const repo = fakeRepo({ upsertModChannel });

        const result = await setWarningsModChannel('guild-1', 'channel-1', {
            getGuild: async () => fakeGuild,
            repo,
        });

        expect(validateMock).toHaveBeenCalledWith(fakeGuild, 'channel-1');
        expect(upsertModChannel).toHaveBeenCalledWith('guild-1', 'channel-1');
        expect(result).toEqual({ ok: true, config: savedConfig });
    });

    it('surfaces the validator message and never persists on validation failure', async () => {
        const failure: WarningModChannelValidation = {
            ok: false,
            userMessage: 'Please choose a normal text channel for warning notices.',
            logMessage: 'not a text channel',
        };
        validateMock.mockResolvedValue(failure);
        const upsertModChannel = vi.fn();
        const repo = fakeRepo({ upsertModChannel });

        const result = await setWarningsModChannel('guild-1', 'bad-channel', {
            getGuild: async () => fakeGuild,
            repo,
        });

        expect(upsertModChannel).not.toHaveBeenCalled();
        expect(result).toEqual({ ok: false, message: failure.userMessage });
    });

    it('fails cleanly when the guild is unavailable', async () => {
        const upsertModChannel = vi.fn();
        const repo = fakeRepo({ upsertModChannel });

        const result = await setWarningsModChannel('guild-1', 'channel-1', {
            getGuild: async () => null,
            repo,
        });

        expect(validateMock).not.toHaveBeenCalled();
        expect(upsertModChannel).not.toHaveBeenCalled();
        expect(result.ok).toBe(false);
    });
});
