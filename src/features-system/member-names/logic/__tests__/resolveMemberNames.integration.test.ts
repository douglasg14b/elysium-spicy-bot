import type { Guild } from 'discord.js';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { TestDiscord, type ServerGuild, type ServerMember } from '../../../../shared/__tests__/support/testDiscord';
import { database } from '../../../data-persistence/database';
import { migrateTestDatabase } from '../../../data-persistence/__tests__/support/migrateTestDatabase';
import { memberAvatarsRepo } from '../../data/memberAvatarsRepo';
import { memberNamesRepo } from '../../data/memberNamesRepo';
import { memberAvatarDownloads } from '../../memberAvatarDownloads';
import { MEMBER_NAME_LOOKUP_CAP, resolveMemberNames } from '../resolveMemberNames';

/**
 * The dashboard's name lookup against TestDiscord and real SQLite: what is stored is
 * answered as stored, a member the bot holds is recorded for free, anyone else is asked
 * of Discord — at most {@link MEMBER_NAME_LOOKUP_CAP} a call — and remembered, and an id
 * Discord has no account for is left out.
 */

/** A valid snowflake no account has. */
const NOBODY_ID = '400000000000000077';

let discord: TestDiscord;
let guild: ServerGuild;
let liveGuild: Guild;

/** A member who left before the bot started, so the client has never seen their account. */
function leftBeforeStart(index = 0): ServerMember {
    const member = guild.createMember({ username: `gone-${index}`, globalName: `Gone ${index}` });
    guild.removeMember(member);
    return member;
}

function userLookups(): number {
    return discord.requests.filter((request) => request.method === 'GET' && request.path.startsWith('/users/')).length;
}

function lookupsOf(userId: string): number {
    return discord.requests.filter((request) => request.method === 'GET' && request.path === `/users/${userId}`).length;
}

/** Discord's CDN, stood in for: every avatar asked for answers `status`, a PNG when it is 200. */
function stubCdn(status = 200) {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 5]);
    const cdn = vi.fn(async (input: string | URL | Request) => {
        const url = input instanceof Request ? input.url : String(input);
        if (!url.startsWith('https://cdn.discordapp.com/avatars/')) throw new Error(`No network in this test: ${url}`);
        return status === 200 ? new Response(png, { status }) : new Response(null, { status });
    });
    vi.stubGlobal('fetch', cdn);
    return cdn;
}

/**
 * A row recorded as gone before avatars were kept: no hash, never checked — as the migration
 * leaves every existing row.
 */
async function departedFromBefore(userId: string): Promise<void> {
    await memberNamesRepo.recordLookedUp(guild.id, [
        { userId, username: 'from-before', globalName: null, avatarHash: null, isBot: false },
    ]);
    await database
        .updateTable('member_names')
        .set({ avatarHash: null, avatarCheckedAt: null })
        .where('guildId', '=', guild.id)
        .where('userId', '=', userId)
        .execute();
}

beforeAll(async () => {
    await migrateTestDatabase();
});

beforeEach(async () => {
    await database.deleteFrom('member_names').execute();
    await database.deleteFrom('member_avatars').execute();
    discord = new TestDiscord();
    guild = discord.createGuild();
});

afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    await discord.destroy();
});

async function start(): Promise<void> {
    await discord.start();
    liveGuild = discord.clientGuild(guild);
}

describe('resolveMemberNames', () => {
    it('answers a stored row as stored, asking Discord nothing', async () => {
        const gone = leftBeforeStart();
        await start();
        await memberNamesRepo.recordPresent(guild.id, [
            { userId: gone.id, username: 'remembered', globalName: null, nickname: 'Old Nick', avatarHash: null, isBot: false },
        ]);

        const [row] = await resolveMemberNames(liveGuild, [gone.id]);

        expect(row).toMatchObject({ username: 'remembered', nickname: 'Old Nick', inServer: true });
        expect(userLookups()).toBe(0);
    });

    it('records a member the bot holds as in the server, with their nickname, asking Discord nothing', async () => {
        const member = guild.createMember({ username: 'present', nickname: 'Here' });
        await start();

        const [row] = await resolveMemberNames(liveGuild, [member.id]);

        expect(row).toMatchObject({ username: 'present', nickname: 'Here', inServer: true });
        expect(userLookups()).toBe(0);
    });

    it('looks up somebody nobody has seen, records them as not in the server, and asks only once', async () => {
        const gone = leftBeforeStart();
        await start();

        const [first] = await resolveMemberNames(liveGuild, [gone.id]);
        const [second] = await resolveMemberNames(liveGuild, [gone.id]);

        expect(first).toMatchObject({
            userId: gone.id,
            username: 'gone-0',
            globalName: 'Gone 0',
            nickname: null,
            inServer: false,
            leftAt: null,
        });
        expect(second).toMatchObject({ username: 'gone-0' });
        expect(userLookups()).toBe(1);
        // Remembered in the table, not in the client's user cache, which nothing sweeps.
        expect(liveGuild.client.users.cache.has(gone.id)).toBe(false);
    });

    it('records the avatar of a member the bot holds and of somebody looked up, and keeps both pictures', async () => {
        stubCdn();
        const present = guild.createMember({ username: 'present', avatar: 'hereface' });
        const gone = guild.createMember({ username: 'gone', avatar: 'goneface' });
        guild.removeMember(gone);
        await start();

        const rows = await resolveMemberNames(liveGuild, [present.id, gone.id]);
        await memberAvatarDownloads.whenIdle();

        expect(new Map(rows.map((row) => [row.userId, row.avatarHash]))).toEqual(
            new Map([
                [present.id, 'hereface'],
                [gone.id, 'goneface'],
            ])
        );
        expect(await memberAvatarsRepo.storedHashes([present.id, gone.id])).toEqual(
            new Map([
                [present.id, 'hereface'],
                [gone.id, 'goneface'],
            ])
        );
    });

    it('leaves out an id Discord has no account for, and records nothing for it', async () => {
        await start();

        expect(await resolveMemberNames(liveGuild, [NOBODY_ID])).toEqual([]);
        expect(await memberNamesRepo.findByUserIds(guild.id, [NOBODY_ID])).toEqual([]);
    });

    it('leaves out an id whose lookup failed, and still answers the names already stored', async () => {
        const failing = leftBeforeStart(0);
        const remembered = leftBeforeStart(1);
        await start();
        await memberNamesRepo.recordPresent(guild.id, [
            { userId: remembered.id, username: 'remembered', globalName: null, nickname: null, avatarHash: null, isBot: false },
        ]);
        vi.spyOn(liveGuild.client.users, 'fetch').mockRejectedValueOnce(new Error('Discord fell over'));
        const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);

        const rows = await resolveMemberNames(liveGuild, [failing.id, remembered.id]);

        expect(rows.map((row) => row.userId)).toEqual([remembered.id]);
        expect(logged).toHaveBeenCalledTimes(1);
        expect(await memberNamesRepo.findByUserIds(guild.id, [failing.id])).toEqual([]);
    });

    it(`asks Discord about at most ${MEMBER_NAME_LOOKUP_CAP} ids a call, and the rest on the next`, async () => {
        const ids = Array.from({ length: MEMBER_NAME_LOOKUP_CAP + 5 }, (_unused, index) => leftBeforeStart(index).id);
        await start();

        const first = await resolveMemberNames(liveGuild, ids);

        expect(first).toHaveLength(MEMBER_NAME_LOOKUP_CAP);
        expect(userLookups()).toBe(MEMBER_NAME_LOOKUP_CAP);

        const second = await resolveMemberNames(liveGuild, ids);

        expect(second).toHaveLength(MEMBER_NAME_LOOKUP_CAP + 5);
        expect(userLookups()).toBe(MEMBER_NAME_LOOKUP_CAP + 5);
    });
});

describe('resolveMemberNames refreshing somebody who has left', () => {
    /** Somebody gone before the bot started, with an avatar, and a row from before avatars were kept. */
    async function goneWithAvatar(avatar: string): Promise<ServerMember> {
        const member = guild.createMember({ username: 'ghosted', avatar });
        guild.removeMember(member);
        await departedFromBefore(member.id);
        return member;
    }

    it('refreshes a row never checked, taking their avatar and keeping the picture', async () => {
        stubCdn();
        const gone = await goneWithAvatar('lastface');
        await start();

        const [row] = await resolveMemberNames(liveGuild, [gone.id]);
        await memberAvatarDownloads.whenIdle();

        expect(row).toMatchObject({ userId: gone.id, username: 'ghosted', avatarHash: 'lastface', inServer: false });
        expect(row?.avatarCheckedAt).toBeInstanceOf(Date);
        expect(lookupsOf(gone.id)).toBe(1);
        expect(await memberAvatarsRepo.storedHashes([gone.id])).toEqual(new Map([[gone.id, 'lastface']]));

        // Checked and held: nothing more to ask.
        await resolveMemberNames(liveGuild, [gone.id]);
        expect(lookupsOf(gone.id)).toBe(1);
    });

    it('refreshes a row whose picture never arrived once a process, not on every load', async () => {
        stubCdn(500);
        vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const member = guild.createMember({ username: 'unlucky', avatar: 'face' });
        guild.removeMember(member);
        // Checked, with an avatar, and no picture held: its download failed.
        await memberNamesRepo.recordLookedUp(guild.id, [
            { userId: member.id, username: 'unlucky', globalName: null, avatarHash: 'face', isBot: false },
        ]);
        await start();

        await resolveMemberNames(liveGuild, [member.id]);
        await memberAvatarDownloads.whenIdle();
        await resolveMemberNames(liveGuild, [member.id]);
        await memberAvatarDownloads.whenIdle();

        expect(lookupsOf(member.id)).toBe(1);
        expect(await memberAvatarsRepo.storedHashes([member.id])).toEqual(new Map());
    });

    it('marks a deleted account checked with no avatar, keeping its names', async () => {
        await departedFromBefore(NOBODY_ID);
        await start();

        const [row] = await resolveMemberNames(liveGuild, [NOBODY_ID]);

        expect(lookupsOf(NOBODY_ID)).toBe(1);
        expect(row).toMatchObject({ userId: NOBODY_ID, username: 'from-before', avatarHash: null });
        expect(row?.avatarCheckedAt).toBeInstanceOf(Date);
    });

    it('spends the lookup cap on ids nobody has seen first, refreshing on a later call', async () => {
        stubCdn();
        const gone = await goneWithAvatar('waitface');
        const strangers = Array.from({ length: MEMBER_NAME_LOOKUP_CAP }, (_unused, index) => leftBeforeStart(index).id);
        await start();

        await resolveMemberNames(liveGuild, [gone.id, ...strangers]);

        expect(userLookups()).toBe(MEMBER_NAME_LOOKUP_CAP);
        expect(lookupsOf(gone.id)).toBe(0);
        expect((await memberNamesRepo.findByUserIds(guild.id, [gone.id]))[0]?.avatarCheckedAt).toBeNull();

        const [row] = await resolveMemberNames(liveGuild, [gone.id]);
        await memberAvatarDownloads.whenIdle();

        expect(lookupsOf(gone.id)).toBe(1);
        expect(row?.avatarHash).toBe('waitface');
    });
});
