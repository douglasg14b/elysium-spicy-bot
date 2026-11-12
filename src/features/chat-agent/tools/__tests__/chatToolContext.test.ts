import { ChannelType, type GuildMember, type GuildTextBasedChannel } from 'discord.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EMPTY_CHAT_AGENT_CONFIG, type ChatAgentConfig } from '../../data/chatAgentConfigSchema';

const savedConfig = vi.hoisted(() => ({ current: {} as Partial<ChatAgentConfig> }));
vi.mock('../../data/chatAgentConfigRepo', () => ({
    chatAgentConfigRepo: { getConfig: async () => ({ ...EMPTY_CHAT_AGENT_CONFIG, serverNotes: 'Munches monthly.', ...savedConfig.current }) },
}));
vi.mock('../../../../features-system/guild-settings', () => ({
    guildSettingsRepo: { getStaffRoleIds: async (guildId: string) => (guildId === 'guild' ? ['300000000000000001'] : []) },
}));

const { buildChatToolContext } = await import('../chatToolContext');

describe('buildChatToolContext', () => {
    beforeEach(() => {
        savedConfig.current = {};
    });

    function turnIn() {
        const guild = { id: 'guild', members: { cache: new Map() } };
        const asker = { id: 'vex', guild } as unknown as GuildMember;
        const channel = { id: 'channel', guild, permissionsFor: () => ({ has: () => true }) } as unknown as GuildTextBasedChannel;
        return buildChatToolContext(channel, asker, null);
    }

    it("reads the server's chat agent config into the turn, and Server Settings' staff roles while the agent has none of its own", async () => {
        savedConfig.current = { introsChannelId: '100000000000000009' };

        expect(await turnIn()).toMatchObject({
            serverNotes: 'Munches monthly.',
            staffRoleIds: ['300000000000000001'],
            introsChannelId: '100000000000000009',
        });
    });

    it("takes the chat agent's own staff roles over Server Settings' once it has some", async () => {
        savedConfig.current = { staffRoleIds: ['300000000000000007'] };

        expect((await turnIn()).staffRoleIds).toEqual(['300000000000000007']);
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
