import { ChannelType, PermissionsBitField, type ChatInputCommandInteraction } from 'discord.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    get: vi.fn(),
    configure: vi.fn(),
    remove: vi.fn(),
    has: vi.fn(),
}));

vi.mock('../data/flashChatRepo', () => ({ flashChatRepo: { get: mocks.get } }));
vi.mock('../flashChatService', () => ({
    flashChatService: { configure: mocks.configure, remove: mocks.remove },
}));
vi.mock('../flashChatManager', () => ({ flashChatManager: { has: mocks.has } }));

const { handleFlashChatCommand } = await import('../flashChatCommand');

const CHANNEL_ID = '111111111111111111';

function fakeInteraction(subcommand: 'on' | 'off', options: Record<string, number | boolean> = {}) {
    const channel = {
        id: CHANNEL_ID,
        name: 'confessions',
        type: ChannelType.GuildText,
        permissionsFor: () => new PermissionsBitField(PermissionsBitField.All),
        toString: () => `<#${CHANNEL_ID}>`,
    };
    const interaction = {
        channelId: CHANNEL_ID,
        guild: {
            id: 'guild-1',
            members: { me: { id: 'bot' } },
            channels: { cache: new Map([[CHANNEL_ID, channel]]) },
        },
        user: { id: 'user-1', username: 'mod', tag: 'mod', displayAvatarURL: () => '' },
        options: {
            getSubcommand: () => subcommand,
            getInteger: (name: string) => options[name],
            getBoolean: (name: string) => options[name],
        },
        reply: vi.fn(),
        deferReply: vi.fn().mockResolvedValue(undefined),
        editReply: vi.fn().mockResolvedValue(undefined),
    };
    return interaction;
}

const ON_OPTIONS = { timeout: 300, 'preserve-pinned': true, 'preserve-history': true, replace: false };

beforeEach(() => {
    vi.resetAllMocks();
});

describe('/flash-chat', () => {
    it('says so when switched off where flash chat is not on', async () => {
        mocks.remove.mockResolvedValue(null);
        const interaction = fakeInteraction('off');

        await handleFlashChatCommand(interaction as unknown as ChatInputCommandInteraction);

        expect(interaction.editReply).toHaveBeenCalledWith(`❌ Flash chat is not enabled in <#${CHANNEL_ID}>.`);
    });

    it('refuses to change a channel already on without `replace`', async () => {
        mocks.get.mockResolvedValue({ channelId: CHANNEL_ID });
        const interaction = fakeInteraction('on', ON_OPTIONS);

        await handleFlashChatCommand(interaction as unknown as ChatInputCommandInteraction);

        expect(mocks.configure).not.toHaveBeenCalled();
        expect(interaction.editReply).toHaveBeenCalledWith(expect.stringContaining('already on'));
    });

    it('answers the deferred reply when the work behind it throws, rather than leaving it thinking', async () => {
        mocks.remove.mockRejectedValue(new Error('database is locked'));
        const interaction = fakeInteraction('off');
        const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

        try {
            const result = await handleFlashChatCommand(interaction as unknown as ChatInputCommandInteraction);

            expect(interaction.deferReply).toHaveBeenCalled();
            expect(interaction.editReply).toHaveBeenCalledWith(expect.stringContaining('Try again'));
            expect(result).toEqual(expect.objectContaining({ status: 'error' }));
        } finally {
            error.mockRestore();
        }
    });

    it('tells the operator when the settings saved but the bot could not start deleting', async () => {
        mocks.get.mockResolvedValue(null);
        mocks.configure.mockResolvedValue({ channelId: CHANNEL_ID });
        mocks.has.mockReturnValue(undefined);
        const interaction = fakeInteraction('on', ON_OPTIONS);

        await handleFlashChatCommand(interaction as unknown as ChatInputCommandInteraction);

        expect(interaction.editReply).toHaveBeenCalledWith(expect.stringContaining("Saved, but I couldn't start"));
    });
});
