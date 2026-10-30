import type { Guild } from 'discord.js';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { TestDiscord, type ServerGuild, type ServerMember } from '../../../../shared/__tests__/support/testDiscord';
import { database } from '../../../data-persistence/database';
import { migrateTestDatabase } from '../../../data-persistence/__tests__/support/migrateTestDatabase';
import { memberNamesRepo } from '../../data/memberNamesRepo';
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

beforeAll(async () => {
    await migrateTestDatabase();
});

beforeEach(async () => {
    await database.deleteFrom('member_names').execute();
    discord = new TestDiscord();
    guild = discord.createGuild();
});

afterEach(async () => {
    vi.restoreAllMocks();
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
            { userId: gone.id, username: 'remembered', globalName: null, nickname: 'Old Nick', isBot: false },
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
            { userId: remembered.id, username: 'remembered', globalName: null, nickname: null, isBot: false },
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
