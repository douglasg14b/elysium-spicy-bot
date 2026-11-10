import { ChannelType, type GuildMember, type GuildTextBasedChannel } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../data/chatAgentConfigRepo', () => ({
    chatAgentConfigRepo: { getConfig: async () => ({ contextChannels: [], serverNotes: 'Munches monthly.', botRules: '' }) },
}));
vi.mock('../../../../features-system/guild-settings', () => ({
    guildSettingsRepo: { getStaffRoleIds: async (guildId: string) => (guildId === 'guild' ? ['300000000000000001'] : []) },
}));

const { buildChatToolContext } = await import('../chatToolContext');

describe('buildChatToolContext', () => {
    it("reads the server's chat agent config and staff roles into the turn", async () => {
        const guild = { id: 'guild', members: { cache: new Map() } };
        const asker = { id: 'vex', guild } as unknown as GuildMember;
        const channel = { id: 'channel', guild, permissionsFor: () => ({ has: () => true }) } as unknown as GuildTextBasedChannel;

        const context = await buildChatToolContext(channel, asker, null);

        expect(context).toMatchObject({ serverNotes: 'Munches monthly.', staffRoleIds: ['300000000000000001'] });
    });

    it("asks Discord who is in a private thread first, since the cache knows only who joined while it watched", async () => {
        const guild = { id: 'guild', members: { cache: new Map() } };
        const asker = { id: 'mod', guild } as unknown as GuildMember;
        const fetchMembers = vi.fn(async () => undefined);
        const thread = {
            id: 'thread',
            guild,
            type: ChannelType.PrivateThread,
            members: { fetch: fetchMembers, cache: new Map() },
            permissionsFor: () => ({ has: () => true }),
        } as unknown as GuildTextBasedChannel;

        await buildChatToolContext(thread, asker, null);

        expect(fetchMembers).toHaveBeenCalled();
    });
});

