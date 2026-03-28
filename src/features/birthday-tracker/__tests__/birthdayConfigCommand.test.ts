import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ChannelType, PermissionsBitField } from 'discord.js';
import type { ChatInputCommandInteraction } from 'discord.js';
import { handleBirthdayConfigCommand } from '../commands/birthdayConfigCommand';

const { upsertAnnouncementChannel } = vi.hoisted(() => ({
    upsertAnnouncementChannel: vi.fn(),
}));

vi.mock('../data/birthdayConfigRepo', () => ({
    birthdayConfigRepository: {
        upsertAnnouncementChannel,
    },
}));

function buildTextChannel(options: { canSend?: boolean } = {}) {
    const canSend = options.canSend ?? true;
    return {
        id: 'channel-1',
        type: ChannelType.GuildText,
        permissionsFor: vi.fn().mockReturnValue({
            has: vi.fn().mockReturnValue(canSend),
        }),
    };
}

function buildInteraction(channel: ReturnType<typeof buildTextChannel>): ChatInputCommandInteraction {
    const reply = vi.fn().mockResolvedValue(undefined);
    const guild = {
        id: 'guild-1',
        members: {
            me: { id: 'bot' },
        },
    };
    return {
        inGuild: () => true,
        guildId: 'guild-1',
        guild,
        memberPermissions: {
            has: (flag: bigint) => flag === PermissionsBitField.Flags.ManageGuild,
        },
        options: {
            getChannel: (_name: string, required?: boolean) => {
                if (required !== true) {
                    throw new Error('expected required channel');
                }
                return channel;
            },
        },
        reply,
    } as unknown as ChatInputCommandInteraction;
}

describe('handleBirthdayConfigCommand', () => {
    beforeEach(() => {
        upsertAnnouncementChannel.mockReset();
    });

    it('persists channel and replies with success', async () => {
        upsertAnnouncementChannel.mockResolvedValue(undefined);
        const interaction = buildInteraction(buildTextChannel());

        const result = await handleBirthdayConfigCommand(interaction);

        expect(result.status).toBe('success');
        expect(upsertAnnouncementChannel).toHaveBeenCalledWith('guild-1', 'channel-1');
        expect(interaction.reply).toHaveBeenCalledWith(
            expect.objectContaining({
                ephemeral: true,
            })
        );
    });

    it('rejects when bot cannot view or send', async () => {
        const interaction = buildInteraction(buildTextChannel({ canSend: false }));

        const result = await handleBirthdayConfigCommand(interaction);

        expect(result.status).toBe('error');
        expect(upsertAnnouncementChannel).not.toHaveBeenCalled();
    });
});
