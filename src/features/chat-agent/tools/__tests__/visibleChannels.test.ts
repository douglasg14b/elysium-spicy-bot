import { ChannelType, PermissionFlagsBits } from 'discord.js';
import type { GuildBasedChannel, GuildMember } from 'discord.js';
import { describe, expect, it } from 'vitest';
import { findVisibleChannel, listVisibleChannels, memberCanSee, readableTextChannel, type Viewers } from '../visibleChannels';

type FakeChannelSpec = {
    id: string;
    name: string;
    type?: ChannelType;
    position?: number;
    /** Member ids with View Channel (a thread's are its parent's, as in discord.js). The bot always has it. */
    viewers: readonly string[];
    /** Member ids who may also read history; defaults to every viewer. */
    historyReaders?: readonly string[];
    /** Member ids with Manage Threads. */
    threadManagers?: readonly string[];
    /** Members of a private thread. */
    threadMembers?: readonly string[];
    /** discord.js answers null for a thread whose parent is not cached. */
    noPermissions?: boolean;
};

const BOT_ID = 'bot';
const THREAD_TYPES = new Set([ChannelType.PublicThread, ChannelType.PrivateThread, ChannelType.AnnouncementThread]);

function fakeGuild(specs: readonly FakeChannelSpec[]) {
    const channels = new Map<string, GuildBasedChannel>();
    const guild = { channels: { cache: channels }, members: { me: { id: BOT_ID } } };
    for (const spec of specs) {
        const type = spec.type ?? ChannelType.GuildText;
        const granted = (who: string, flag: bigint): boolean => {
            if (who === BOT_ID) return true;
            if (flag === PermissionFlagsBits.ViewChannel) return spec.viewers.includes(who);
            if (flag === PermissionFlagsBits.ReadMessageHistory) return (spec.historyReaders ?? spec.viewers).includes(who);
            if (flag === PermissionFlagsBits.ManageThreads) return spec.threadManagers?.includes(who) ?? false;
            return false;
        };
        const channel = {
            id: spec.id,
            name: spec.name,
            type,
            position: spec.position ?? 0,
            parent: null,
            members: { cache: new Set(spec.threadMembers ?? []) },
            isThread: () => THREAD_TYPES.has(type),
            isTextBased: () => type !== ChannelType.GuildCategory && type !== ChannelType.GuildForum,
            permissionsFor: (who: { id: string }) =>
                spec.noPermissions
                    ? null
                    : {
                          has: (flags: bigint | readonly bigint[]) =>
                              (Array.isArray(flags) ? flags : [flags]).every((flag: bigint) => granted(who.id, flag)),
                      },
        };
        channels.set(spec.id, channel as unknown as GuildBasedChannel);
    }
    const member = (id: string) => ({ id, guild }) as unknown as GuildMember;
    return { channels, member };
}

const SERVER = fakeGuild([
    { id: '100000000000000001', name: 'general', position: 0, viewers: ['vex', 'mod'] },
    { id: '100000000000000002', name: 'staff-notes', position: 1, viewers: ['mod'] },
    { id: '100000000000000003', name: 'general-nsfw', position: 2, viewers: ['vex', 'mod'] },
    { id: '100000000000000004', name: 'Lounge', type: ChannelType.GuildCategory, viewers: ['vex', 'mod'] },
    {
        id: '100000000000000005',
        name: 'ban-appeal-vex-discussion',
        type: ChannelType.PrivateThread,
        viewers: ['vex', 'mod'],
        threadManagers: ['mod'],
    },
    { id: '100000000000000006', name: 'confessions', position: 3, viewers: ['vex', 'mod'], historyReaders: ['mod'] },
    { id: '100000000000000007', name: 'orphan-thread', type: ChannelType.PublicThread, viewers: ['vex'], noPermissions: true },
]);

const vex = SERVER.member('vex');
const mod = SERVER.member('mod');
/** An answer only its asker reads (a DM-like private view) — each member alone. */
const alone = (member: GuildMember): Viewers => [member];
const channel = (id: string) => SERVER.channels.get(id)!;

describe('channel visibility', () => {
    it('never lists a channel the asker cannot see, though the bot can', () => {
        expect(listVisibleChannels(alone(vex)).map((visible) => visible.name)).toEqual(['general', 'general-nsfw', 'confessions']);
        expect(listVisibleChannels(alone(mod)).map((visible) => visible.name)).toContain('staff-notes');
    });

    it('will not find a hidden channel by name, mention or id', () => {
        expect(findVisibleChannel(alone(vex), 'staff-notes')).toBeUndefined();
        expect(findVisibleChannel(alone(vex), '#staff')).toBeUndefined();
        expect(findVisibleChannel(alone(vex), '<#100000000000000002>')).toBeUndefined();
        expect(findVisibleChannel(alone(vex), '100000000000000002')).toBeUndefined();
    });

    it("treats a private thread as hidden from anyone who is neither in it nor manages threads, whatever its parent's permissions", () => {
        const thread = channel('100000000000000005');
        expect(memberCanSee(vex, thread)).toBe(false);
        expect(memberCanSee(mod, thread)).toBe(true);
        expect(findVisibleChannel(alone(vex), 'ban')).toBeUndefined();
    });

    it('counts a channel discord.js cannot answer for as hidden rather than failing', () => {
        expect(memberCanSee(vex, channel('100000000000000007'))).toBe(false);
    });

    it('will not read a channel the asker cannot see, or can see but not read back', () => {
        expect(readableTextChannel(alone(vex), channel('100000000000000002'))).toBeUndefined();
        expect(readableTextChannel(alone(mod), channel('100000000000000002'))).toBe(channel('100000000000000002'));
        expect(readableTextChannel(alone(vex), channel('100000000000000006'))).toBeUndefined();
        expect(readableTextChannel(alone(mod), channel('100000000000000006'))).toBe(channel('100000000000000006'));
    });

    it('prefers an exact name over a partial one', () => {
        expect(findVisibleChannel(alone(vex), '#general')?.name).toBe('general');
        expect(findVisibleChannel(alone(vex), 'nsfw')?.name).toBe('general-nsfw');
    });

    it("shows only what everyone reading the answer can see: a moderator asking in front of members gets no staff channels", () => {
        const modAskingInGeneral: Viewers = [mod, vex];
        expect(listVisibleChannels(modAskingInGeneral).map((visible) => visible.name)).not.toContain('staff-notes');
        expect(findVisibleChannel(modAskingInGeneral, 'staff-notes')).toBeUndefined();
        expect(readableTextChannel(modAskingInGeneral, channel('100000000000000002'))).toBeUndefined();
        // …and nothing whose history some of them can't read back.
        expect(readableTextChannel(modAskingInGeneral, channel('100000000000000006'))).toBeUndefined();
    });
});
