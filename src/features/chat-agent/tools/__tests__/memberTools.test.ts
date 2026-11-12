import { type Guild, type GuildMember, type GuildTextBasedChannel } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';
import type { ChatToolContext } from '../chatToolContext';
import type { Viewers } from '../visibleChannels';

const loadUserLevelProfile = vi.fn(async () => ({ level: 7, totalXp: 1_240, xpToNextLevel: 260, hasAnyActivity: true }));
vi.mock('../../../leveling', () => ({ loadUserLevelProfile }));

const { getMemberInfoTool, getUserLevelTool } = await import('../memberTools');

const STAFF_ROLE = '300000000000000001';
const guild = { id: 'guild', ownerId: 'owner', memberCount: 2, members: { cache: { size: 2 } } };

function member(id: string, roles: readonly { id: string; name: string; position: number }[]): GuildMember {
    return {
        id,
        guild,
        displayName: id,
        user: { username: id, bot: false },
        joinedAt: null,
        premiumSince: null,
        permissions: { has: () => false },
        roles: { cache: new Map(roles.map((role) => [role.id, role])) },
    } as unknown as GuildMember;
}

const mod = member('mod', [{ id: STAFF_ROLE, name: 'Moderator', position: 9 }]);
const vex = member('vex', [
    { id: '1', name: 'Verified', position: 5 },
    { id: '2', name: '🌸 she/her', position: 1 },
    { id: '3', name: 'Dom/sub', position: 2 },
]);

function contextFor(viewers: Viewers): ChatToolContext {
    return {
        guild: guild as unknown as Guild,
        channel: { id: 'channel', name: 'general' } as unknown as GuildTextBasedChannel,
        asker: viewers[0],
        viewers,
        viewersCanReadHistory: true,
        ticket: null,
        contextChannels: [],
        serverNotes: '',
        botRules: '',
        staffRoleIds: [STAFF_ROLE],
        introsChannelId: null,
    };
}

async function run<Input>(tool: { execute?: (input: Input, options: never) => unknown }, input: Input) {
    if (!tool.execute) throw new Error('tool has no execute');
    return tool.execute(input, { toolCallId: 'call-1', messages: [] } as never);
}

describe('getUserLevel', () => {
    it('answers where every reader is staff', async () => {
        expect(await run(getUserLevelTool(contextFor([mod])), {})).toMatchObject({ found: true, level: 7, xpToNextLevel: 260 });
    });

    it("won't tell a member their level in public, points them at /level, and reads nothing", async () => {
        loadUserLevelProfile.mockClear();
        const answer = await run(getUserLevelTool(contextFor([vex, mod])), {});

        expect(answer).toMatchObject({ found: false, tellThem: expect.stringContaining('/level') });
        expect(JSON.stringify(answer)).not.toMatch(/\b(7|260|1240)\b/);
        expect(loadUserLevelProfile).not.toHaveBeenCalled();
    });

    it('nor staff, where members can read along', async () => {
        expect(await run(getUserLevelTool(contextFor([mod, vex])), { member: 'vex' })).toMatchObject({
            found: false,
            reason: expect.stringContaining("People who aren't staff"),
        });
    });
});

describe('getMemberInfo', () => {
    it('names their pronoun roles on their own, past the role list, and not a kink role with a slash', async () => {
        const answer = await run(getMemberInfoTool(contextFor([vex])), {});
        expect(answer).toMatchObject({ found: true, pronouns: ['🌸 she/her'] });
    });
});
