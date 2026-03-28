import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatInputCommandInteraction } from 'discord.js';
import { handleBirthdayCommand } from '../commands/birthdayCommand';
import { BIRTHDAY_ANNOUNCEMENT_CONFIG_WARNING } from '../constants';

const get = vi.fn();
const isConfigured = vi.fn();

vi.mock('../data/birthdayRepo', () => ({
    birthdayRepository: {
        get,
    },
}));

vi.mock('../data/birthdayConfigRepo', () => ({
    birthdayConfigRepository: {
        isConfigured,
    },
}));

vi.mock('../components/birthdayActionSelect', () => ({
    BirthdayActionSelectComponent: {
        buildBirthdayInfoEmbed: vi.fn().mockReturnValue({ data: { title: 'embed' } }),
        buildComponent: vi.fn().mockReturnValue({ data: { components: [] } }),
    },
}));

describe('handleBirthdayCommand', () => {
    beforeEach(() => {
        get.mockReset();
        isConfigured.mockReset();
    });

    it('includes config warning when birthday exists and guild is not configured', async () => {
        get.mockResolvedValue({
            guildId: 'g',
            userId: 'u',
            month: 1,
            day: 2,
            year: null,
            displayName: 'x',
            username: 'x',
        });
        isConfigured.mockResolvedValue(false);

        const reply = vi.fn().mockResolvedValue(undefined);
        const interaction = {
            guildId: 'g',
            user: { id: 'u' },
            reply,
        } as unknown as ChatInputCommandInteraction;

        await handleBirthdayCommand(interaction);

        expect(reply).toHaveBeenCalledWith(
            expect.objectContaining({
                content: BIRTHDAY_ANNOUNCEMENT_CONFIG_WARNING,
            })
        );
    });

    it('does not include config warning when configured', async () => {
        get.mockResolvedValue({
            guildId: 'g',
            userId: 'u',
            month: 1,
            day: 2,
            year: null,
            displayName: 'x',
            username: 'x',
        });
        isConfigured.mockResolvedValue(true);

        const reply = vi.fn().mockResolvedValue(undefined);
        const interaction = {
            guildId: 'g',
            user: { id: 'u' },
            reply,
        } as unknown as ChatInputCommandInteraction;

        await handleBirthdayCommand(interaction);

        expect(reply).toHaveBeenCalledWith(
            expect.objectContaining({
                content: undefined,
            })
        );
    });
});
