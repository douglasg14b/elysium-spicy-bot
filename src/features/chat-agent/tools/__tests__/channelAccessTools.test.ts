import { ChannelType, Collection, OverwriteType, PermissionFlagsBits, PermissionsBitField } from 'discord.js';
import type { Guild, GuildMember, GuildTextBasedChannel } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';
import { ACCESS_MEMBER_LIMIT, getChannelAccessTool } from '../channelAccessTools';
import type { ChatToolContext } from '../chatToolContext';
import type { Viewers } from '../visibleChannels';

const GUILD_ID = '100000000000000000';
const MOD_ROLE = '300000000000000001';
const ADMIN_ROLE = '300000000000000002';
const VERIFIED_ROLE = '300000000000000003';
const BOT_ROLE = '300000000000000004';
const MUTED_ROLE = '300000000000000005';
const HELPER_ROLE = '300000000000000006';
const ROOM_ID = '200000000000000001';
const TICKET_ID = '200000000000000002';
const GENERAL_ID = '200000000000000003';
const SECRET_ID = '200000000000000004';
const THREAD_ID = '200000000000000005';

const { ViewChannel, ManageThreads, SendMessages, Administrator } = PermissionFlagsBits;

function fakeRole(id: string, name: string, position: number, permissions: bigint[], tags: { botId?: string } | null = null) {
    return { id, name, position, permissions: new PermissionsBitField(permissions), tags };
}

const ROLES = [
    fakeRole(GUILD_ID, '@everyone', 0, [ViewChannel, SendMessages]),
    fakeRole(ADMIN_ROLE, 'Owner', 5, [Administrator]),
    fakeRole(MOD_ROLE, 'Moderator', 4, [ManageThreads]),
    fakeRole(BOT_ROLE, 'Carl-bot', 3, [ViewChannel], { botId: 'carl' }),
    fakeRole(HELPER_ROLE, 'Helper', 2, []),
    fakeRole(VERIFIED_ROLE, 'Verified', 2, []),
    fakeRole(MUTED_ROLE, 'Muted', 1, []),
];

type FakeMember = { id: string; displayName: string; roleIds: string[]; bot?: boolean };

const KAT: FakeMember = { id: 'kat', displayName: 'Kat', roleIds: [MOD_ROLE] };
const VEX: FakeMember = { id: 'vex', displayName: 'Vex', roleIds: [MOD_ROLE] };
const RIVER: FakeMember = { id: 'river', displayName: 'River', roleIds: [VERIFIED_ROLE] };
const CARL: FakeMember = { id: 'carl', displayName: 'Carl-bot', roleIds: [BOT_ROLE], bot: true };

function overwrite(id: string, type: OverwriteType, allow: bigint[], deny: bigint[] = []) {
    return [id, { id, type, allow: new PermissionsBitField(allow), deny: new PermissionsBitField(deny) }] as const;
}

/**
 * A channel and the people who can see it. Who sees is given outright (`seenBy`): the member
 * rule is `memberCanSee`'s, tested on its own. What the tool works out itself is each role's
 * reach, from the overwrites.
 */
function fakeChannel(
    id: string,
    name: string,
    seenBy: readonly string[],
    overwrites: readonly (readonly [string, unknown])[],
    extra: Record<string, unknown> = {}
) {
    return {
        id,
        name,
        type: ChannelType.GuildText,
        isTextBased: () => true,
        isThread: () => false,
        parent: null,
        permissionOverwrites: { cache: new Map(overwrites) },
        permissionsFor: (who: { id: string }) => ({
            has: (flags: bigint | bigint[]) => seenBy.includes(who.id) && (![flags].flat().includes(ManageThreads) || who.id === 'kat' || who.id === 'vex'),
        }),
        ...extra,
    };
}

function setup(options: { askerRoles?: string[]; members?: FakeMember[]; extraChannels?: [string, unknown][]; channelsFetch?: ReturnType<typeof vi.fn> } = {}) {
    const people = options.members ?? [KAT, VEX, RIVER, CARL];
    const guild = {
        id: GUILD_ID,
        ownerId: 'owner',
        memberCount: people.length,
        roles: { everyone: ROLES[0], cache: new Collection(ROLES.map((role) => [role.id, role])) },
        members: { me: { id: 'bot' }, cache: new Collection<string, unknown>() },
        channels: { cache: new Collection<string, unknown>(), fetch: options.channelsFetch ?? vi.fn(async () => null) },
    };
    const member = (fake: FakeMember) =>
        ({
            id: fake.id,
            displayName: fake.displayName,
            guild,
            user: { bot: !!fake.bot },
            permissions: { has: () => false },
            roles: { cache: new Map(fake.roleIds.map((roleId) => [roleId, { id: roleId }])) },
        }) as unknown as GuildMember;
    const members = people.map(member);
    for (const each of members) guild.members.cache.set(each.id, each);

    const everyoneId = [...people.map((fake) => fake.id), 'bot'];
    const staffIds = ['kat', 'vex', 'bot'];
    const room = fakeChannel(ROOM_ID, 'mod-chat', staffIds, [overwrite(GUILD_ID, OverwriteType.Role, [], [ViewChannel]), overwrite(MOD_ROLE, OverwriteType.Role, [ViewChannel])]);
    const channels: [string, unknown][] = [
        [ROOM_ID, room],
        [
            TICKET_ID,
            fakeChannel(TICKET_ID, 'ticket-0057-river', [...staffIds, 'river'], [
                overwrite(GUILD_ID, OverwriteType.Role, [], [ViewChannel]),
                overwrite(MOD_ROLE, OverwriteType.Role, [ViewChannel]),
                overwrite(HELPER_ROLE, OverwriteType.Role, [ViewChannel]),
                overwrite(BOT_ROLE, OverwriteType.Role, [ViewChannel]),
                overwrite('river', OverwriteType.Member, [ViewChannel]),
            ]),
        ],
        [GENERAL_ID, fakeChannel(GENERAL_ID, 'general', everyoneId, [overwrite(MUTED_ROLE, OverwriteType.Role, [], [ViewChannel])])],
        [SECRET_ID, fakeChannel(SECRET_ID, 'admin-only', ['bot'], [overwrite(GUILD_ID, OverwriteType.Role, [], [ViewChannel])])],
        ...(options.extraChannels ?? []),
    ];
    for (const [id, channel] of channels) guild.channels.cache.set(id, Object.assign(channel as object, { guild }));

    const asker = { ...members.find((each) => each.id === 'vex'), roles: { cache: new Map((options.askerRoles ?? [MOD_ROLE]).map((roleId) => [roleId, { id: roleId }])) } } as unknown as GuildMember;
    const viewers: Viewers = [asker, members.find((each) => each.id === 'kat') as GuildMember];
    const context = {
        guild: guild as unknown as Guild,
        channel: room as unknown as GuildTextBasedChannel,
        asker,
        viewers,
        staffRoleIds: [MOD_ROLE],
    } as unknown as ChatToolContext;
    const execute = getChannelAccessTool(context).execute;
    if (!execute) throw new Error('getChannelAccess has no execute');
    const access = async (input: { channel?: string }) =>
        (await execute(input, { toolCallId: 'call-1', messages: [], context: undefined } as never)) as Record<string, unknown>;
    return { access, guild, room };
}

describe('getChannelAccess', () => {
    it("names the roles that let someone in and every person who can see it, staff first — from its permissions", async () => {
        const { access } = setup();
        const answer = await access({ channel: '#ticket-0057-river' });

        expect(answer).toEqual({
            found: true,
            channel: '#ticket-0057-river',
            openToEveryone: false,
            // Owner by Administrator, whatever the channel says; Moderator and Helper by their overwrites; no bot's role.
            roles: [{ role: '@Owner', staff: true, administrator: true }, { role: '@Moderator', staff: true }, { role: '@Helper' }],
            people: 3,
            staff: 2,
            members: [{ name: '@Kat', staff: true }, { name: '@Vex', staff: true }, { name: '@River', addedDirectly: true }],
        });
    });

    it('says a channel is open to everyone, naming only the roles it shuts out', async () => {
        const { access } = setup();
        const answer = await access({ channel: '#general' });

        expect(answer).toMatchObject({ found: true, openToEveryone: true, rolesShutOut: [{ role: '@Muted' }], people: 3 });
        expect(answer).not.toHaveProperty('roles');
    });

    it('answers for the channel it is asked in when none is named', async () => {
        const { access } = setup();
        expect(await access({})).toMatchObject({ found: true, channel: '#mod-chat', roles: [{ role: '@Owner' }, { role: '@Moderator' }], people: 2, staff: 2 });
    });

    it("refuses a member who isn't staff, telling them nothing about the channel", async () => {
        const { access } = setup({ askerRoles: [VERIFIED_ROLE] });
        const answer = await access({ channel: '#ticket-0057-river' });

        expect(answer).toMatchObject({ found: false, reason: 'Only staff can ask this.' });
        expect(answer).not.toHaveProperty('members');
    });

    it("won't describe a channel not every reader can see, nor one on another server", async () => {
        const { access } = setup();
        expect(await access({ channel: '#admin-only' })).toMatchObject({ found: false, note: expect.stringContaining('No channel matching') });
        expect(await access({ channel: `<#${SECRET_ID}>` })).toMatchObject({ found: false });
        expect(await access({ channel: `https://discord.com/channels/999999999999999999/${TICKET_ID}` })).toEqual({
            found: false,
            note: 'That link is to another server.',
        });
    });

    it(`lists at most ${ACCESS_MEMBER_LIMIT} people by name, and counts the rest`, async () => {
        const crowd = Array.from({ length: ACCESS_MEMBER_LIMIT + 7 }, (_unused, index) => ({ id: `m${index}`, displayName: `Member ${index}`, roleIds: [] }));
        const { access } = setup({ members: [KAT, VEX, ...crowd] });
        const answer = await access({ channel: '#general' });

        expect(answer).toMatchObject({ people: ACCESS_MEMBER_LIMIT + 9, notListed: 9 });
        expect(answer.members).toHaveLength(ACCESS_MEMBER_LIMIT);
    });

    it("fetches a private thread's members before deciding who can see it, and lets roles in only by Manage Threads", async () => {
        const threadMembers = new Collection<string, unknown>();
        const membersFetch = vi.fn(async () => {
            for (const id of ['kat', 'vex', 'river']) threadMembers.set(id, { id });
        });
        let thread: Record<string, unknown> = {};
        const { access, guild } = setup({ channelsFetch: vi.fn(async () => thread) });
        const parent = guild.channels.cache.get(TICKET_ID);
        thread = {
            ...fakeChannel(THREAD_ID, 'the-damon-thing', ['kat', 'vex', 'river', 'bot'], []),
            type: ChannelType.PrivateThread,
            isThread: () => true,
            parent,
            members: { cache: threadMembers, fetch: membersFetch },
            guild,
        };

        const answer = await access({ channel: `https://discord.com/channels/${GUILD_ID}/${THREAD_ID}` });

        expect(membersFetch).toHaveBeenCalled();
        expect(answer).toMatchObject({
            found: true,
            channel: '#ticket-0057-river',
            thread: 'the-damon-thing',
            // Moderator holds Manage Threads and sees the parent; Helper sees the parent only.
            roles: [{ role: '@Owner' }, { role: '@Moderator' }],
            members: [{ name: '@Kat', staff: true, addedDirectly: true }, { name: '@Vex', staff: true, addedDirectly: true }, { name: '@River', addedDirectly: true }],
        });
    });
});
