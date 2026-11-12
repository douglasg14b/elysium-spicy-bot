import { ChannelType, type Guild, type GuildMember, type GuildTextBasedChannel } from 'discord.js';
import { beforeEach, describe, expect, it } from 'vitest';
import { ChatIntrosRepo } from '../../data/chatIntrosRepo';
import { chatIntrosTestDb } from '../../data/__tests__/support/chatIntrosTestDb';
import type { ChatToolContext } from '../chatToolContext';
import { getMemberIntroTool } from '../introTools';
import type { Viewers } from '../visibleChannels';

const GUILD = 'guild-1';
const INTROS = '100000000000000001';
const MODS_ONLY = '100000000000000002';

/** Who can see what: everyone sees the intros channel; only `mod` sees #mods-only. */
function channel(id: string, name: string, canSee: (memberId: string) => boolean) {
    return {
        id,
        name,
        type: ChannelType.GuildText,
        isTextBased: () => true,
        isThread: () => false,
        permissionsFor: (member: { id: string }) => ({ has: () => canSee(member.id) }),
    };
}

const guild = {
    id: GUILD,
    members: { me: { id: 'bot' }, cache: new Map<string, GuildMember>() },
    roles: { cache: new Map([['300000000000000001', { id: '300000000000000001', name: 'Rope Crew' }]]) },
    channels: {
        cache: new Map([
            [INTROS, channel(INTROS, 'introductions', () => true)],
            [MODS_ONLY, channel(MODS_ONLY, 'mods-only', (memberId) => memberId === 'mod' || memberId === 'bot')],
        ]),
    },
};

function member(id: string, displayName: string): GuildMember {
    const found = { id, displayName, user: { username: id, bot: false }, guild } as unknown as GuildMember;
    guild.members.cache.set(id, found);
    return found;
}

const vex = member('vex', 'Vex');
const mod = member('mod', 'Mod');
member('mara', 'Mara');
member('200000000000000009', 'River');

function contextFor(viewers: Viewers, introsChannelId: string | null = INTROS): ChatToolContext {
    return {
        guild: guild as unknown as Guild,
        channel: { id: 'general', name: 'general' } as unknown as GuildTextBasedChannel,
        asker: viewers[0],
        viewers,
        viewersCanReadHistory: true,
        ticket: null,
        contextChannels: [],
        serverNotes: '',
        botRules: '',
        staffRoleIds: [],
        introsChannelId,
    };
}

let repo: ChatIntrosRepo;

beforeEach(async () => {
    repo = new ChatIntrosRepo(await chatIntrosTestDb());
});

async function ask(context: ChatToolContext, input: { member?: string }) {
    const { execute } = getMemberIntroTool(context, repo);
    if (!execute) throw new Error('getMemberIntro has no execute');
    return execute(input, { toolCallId: 'call-1', messages: [] } as never);
}

describe('getMemberIntro', () => {
    it("reads someone's intro posts oldest first, with names for their mentions — a channel only when every reader can see it", async () => {
        await repo.savePosts([
            { messageId: 'm1', guildId: GUILD, channelId: INTROS, authorId: 'mara', content: 'Mara, they/them, in <@&300000000000000001>.', postedAt: new Date(Date.UTC(2026, 8, 2)) },
            { messageId: 'm2', guildId: GUILD, channelId: INTROS, authorId: 'mara', content: 'Ask <@200000000000000009> about me. I lurk in <#100000000000000002>.', postedAt: new Date(Date.UTC(2026, 8, 3)) },
        ]);

        const answer = await ask(contextFor([vex]), { member: 'Mara' });

        expect(answer).toMatchObject({
            found: true,
            hasIntro: true,
            channel: '#introductions',
            posts: [{ text: 'Mara, they/them, in @Rope Crew.' }, { text: 'Ask @River about me. I lurk in #unknown-channel.' }],
        });
        expect(JSON.stringify(await ask(contextFor([mod]), { member: 'Mara' }))).toContain('#mods-only');
    });

    it('says when someone never introduced themselves', async () => {
        expect(await ask(contextFor([vex]), {})).toMatchObject({ found: true, hasIntro: false });
    });

    it("finds nothing when the server has no intros channel, or one some reader can't see", async () => {
        await repo.savePosts([{ messageId: 'm1', guildId: GUILD, channelId: MODS_ONLY, authorId: 'mara', content: 'secret', postedAt: new Date() }]);

        expect(await ask(contextFor([vex], null), { member: 'Mara' })).toMatchObject({ found: false });
        expect(await ask(contextFor([mod, vex], MODS_ONLY), { member: 'Mara' })).toMatchObject({ found: false });
        expect(getMemberIntroTool(contextFor([mod, vex], MODS_ONLY), repo).description).not.toContain('mods-only');
    });
});
